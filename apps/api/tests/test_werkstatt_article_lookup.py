"""Looking a barcode up: our shelf, the wholesaler's file, then the world.

The behaviour under test is the one the workshop asked for in one sentence —
"when an item is not found in our database we have no great way of adding it" —
and almost all of the risk is in the last step. A suggestion scraped off a
public shop is only ever as good as the check that it describes the product
somebody is actually holding, so the pins that matter most here are the
*refusals*: a page whose GTIN is not the one we asked about, a code that is not
a barcode at all, a provider that is switched off, a URL that points inside the
network.

The cache is pinned just as hard, for a duller reason: the rack station scans
the same unknown code once per delivery, and an uncached miss turns that into
an outbound scrape inside a request handler on a two-worker container that has
been OOM-killed before.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.db import SessionLocal
from app.models.entities import MaterialCatalogItem, User, WerkstattArticle, WerkstattEanLookup
from app.services import gtin
from app.services.ean_lookup import http as ean_http

# A real EAN-13 and its UPC-A twin — the same product, two spellings.
EAN13 = "4012345678901"
UPCA = "012345678905"
UPCA_AS_EAN13 = "0012345678905"


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# ──────────────────────────────────────────────────────────────────────────
# GTIN normalisation — the arithmetic every later decision rests on
# ──────────────────────────────────────────────────────────────────────────


def test_checksum_separates_a_barcode_from_a_typo():
    assert gtin.is_gtin(EAN13)
    assert gtin.is_gtin(UPCA)
    # One digit changed. Not a product, and not worth an outbound request.
    assert not gtin.is_gtin("4012345678902")
    assert not gtin.is_gtin("SP-0042")
    assert not gtin.is_gtin("")


def test_upc_a_and_ean_13_are_the_same_barcode():
    assert gtin.to_ean13(UPCA) == UPCA_AS_EAN13
    assert gtin.to_ean13(EAN13) == EAN13
    # A GTIN-14 carries a packaging digit in front of the trade item.
    assert gtin.to_ean13("1" + EAN13[:-1] + "8") in (None, EAN13)


def test_variants_start_with_the_code_as_scanned():
    """Every caller passes anything through here, barcode or not."""
    assert gtin.variants("SP-0042") == ("SP-0042",)
    variants = gtin.variants(UPCA)
    assert variants[0] == UPCA
    assert UPCA_AS_EAN13 in variants


# ──────────────────────────────────────────────────────────────────────────
# A fake webshop, so the provider's parsing and its GTIN check are real
# ──────────────────────────────────────────────────────────────────────────


def _product_page(gtin13: str, name: str = "Schuko-Steckdose reinweiß") -> str:
    """A page shaped like the shop's: JSON-LD Product plus og: fallbacks."""
    return f"""
    <html><head>
      <meta property="og:title" content="{name} (og)">
      <meta property="og:image" content="https://www.unielektro.de/img/1.jpg">
      <script type="application/ld+json">
      {{"@type": "Product", "name": "{name}", "gtin13": "{gtin13}",
        "brand": {{"name": "Gira"}},
        "image": ["https://www.unielektro.de/img/1.jpg"],
        "offers": {{"@type": "Offer", "unitText": "Stk"}}}}
      </script>
    </head><body>Produkt</body></html>
    """


#: Where the shop's own search sends a barcode that matches one product. The
#: real shop 302s; the path has to look like a product rather than a listing,
#: because a listing may no longer name an article (see `_listing_page`).
PRODUCT_URL = "https://www.unielektro.de/artikel/schuko-4012345678901"


def _listing_page(gtin13: str, *links: str) -> str:
    """A Shopware result page: the barcode in microdata, no Product scope.

    Its ``og:title`` is the QUERY, which is the whole point — a page like this
    used to be accepted as a product and named the article after the search.
    """
    hrefs = "".join(f'<a href="{link}">Treffer</a>' for link in links)
    return f"""
    <html><head>
      <meta property="og:title" content="Suchergebnis für {gtin13} | UNIELEKTRO">
      <meta property="og:image" content="https://www.unielektro.de/img/logo.png">
    </head><body>
      <div class="tile"><span itemprop="gtin13">{gtin13}</span>{hrefs}</div>
    </body></html>
    """


class _Shop:
    """Counts requests, so "the cache stopped a second scrape" is provable.

    Shaped like the real thing: the search URL redirects onto a product page,
    because that is what the shop does and because the provider is no longer
    willing to read a product's identity off a listing.
    """

    def __init__(self, body: str | None, status: int = 200, *, pages=None) -> None:
        self.body = body
        self.status = status
        # {url: (status, body)} — anything the test wants answered verbatim.
        self.pages = dict(pages or {})
        self.requests: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.requests.append(url)
        if url in self.pages:
            status, body = self.pages[url]
            if status in (301, 302):
                return httpx.Response(status, headers={"location": body})
            return httpx.Response(
                status, text=body, headers={"content-type": "text/html; charset=utf-8"}
            )
        if "bing.com" in url:
            # The RSS search is a fallback we do not need here; answering it
            # with nothing keeps the test about the shop page itself.
            return httpx.Response(200, text="<rss></rss>")
        if self.body is None or self.status != 200:
            return httpx.Response(self.status or 404, text="nope")
        if "/search" in url or "/navigator" in url:
            return httpx.Response(302, headers={"location": PRODUCT_URL})
        return httpx.Response(
            200, text=self.body, headers={"content-type": "text/html; charset=utf-8"}
        )


SEARCH_URL = f"https://www.unielektro.de/search?sSearch={EAN13}"
NAVIGATOR_URL = f"https://www.unielektro.de/navigator?query={EAN13}"
LINKED_PRODUCT_URL = "https://www.unielektro.de/artikel/wago-221-413"


def _microdata_page(gtin13: str, name: str, *, extra_gtin: str | None = None) -> str:
    """A product page in the OTHER markup the shop uses: microdata, no JSON-LD.

    Its ``og:title`` is a category heading on purpose — the name has to come
    out of the Product scope that carries the barcode, not off the page.
    """
    second = f'<div class="teaser"><span itemprop="gtin13">{extra_gtin}</span></div>' if extra_gtin else ""
    return f"""
    <html><head>
      <meta property="og:title" content="Verbindungsklemmen | UNIELEKTRO">
    </head><body>
      <div itemscope itemtype="https://schema.org/Product">
        <h1 itemprop="name">{name}</h1>
        <span itemprop="brand">WAGO</span>
        <img itemprop="image" src="/img/wago.jpg">
        <span itemprop="gtin13">{gtin13}</span>
      </div>
      {second}
    </body></html>
    """


@pytest.fixture
def shop(monkeypatch):
    """Install a fake shop and neutralise DNS, keeping the guard testable.

    ``is_public_http_url`` resolves hostnames for real, which a test host may
    not be able to do — so it is stubbed HERE, and the guard's actual
    behaviour is pinned separately in ``test_private_hosts_are_refused``.
    """

    def install(body: str | None, status: int = 200, *, pages=None) -> _Shop:
        handler = _Shop(body, status, pages=pages)

        def build_client(budget):
            return httpx.Client(
                transport=httpx.MockTransport(handler),
                timeout=httpx.Timeout(2.0),
                follow_redirects=False,
            )

        monkeypatch.setattr(ean_http, "build_client", build_client)
        allow = lambda url: url.startswith("https://")  # noqa: E731
        monkeypatch.setattr(ean_http, "is_public_http_url", allow)
        # The provider and `build_hit` run the same guard on the URLs they
        # KEEP (an image src, the source link). Stubbed for the same reason:
        # it resolves hostnames for real, which a test host may not be able
        # to do — its actual behaviour is pinned separately below.
        monkeypatch.setattr(
            "app.services.ean_lookup.unielektro_shop.is_public_http_url", allow, raising=False
        )
        monkeypatch.setattr(
            "app.services.ean_lookup.base.is_public_http_url", allow, raising=False
        )
        monkeypatch.setattr(
            "app.services.ean_lookup.cascade.build_client", build_client, raising=False
        )
        return handler

    return install


@pytest.fixture(autouse=True)
def _enable_webshop(monkeypatch):
    """The scraper is on by default in production, so it is on here too."""
    from app.core.config import get_settings

    settings = get_settings()
    monkeypatch.setattr(settings, "ean_lookup_unielektro_enabled", True, raising=False)
    monkeypatch.setattr(settings, "ean_lookup_provider", "", raising=False)
    monkeypatch.setattr(settings, "ean_lookup_timeout_seconds", 3.0, raising=False)


def _catalog_row(supplier_id: int | None, *, article_no: str, ean: str | None, name: str) -> int:
    with SessionLocal() as db:
        row = MaterialCatalogItem(
            external_key=f"{supplier_id}-{article_no}",
            source_file="test.csv",
            source_line=1,
            article_no=article_no,
            item_name=name,
            ean=ean,
            supplier_id=supplier_id,
            search_text=f"{article_no} {name} {ean or ''}".lower(),
        )
        db.add(row)
        db.commit()
        return row.id


def _lookup(client: TestClient, token: str, code: str) -> dict:
    response = client.get(
        "/api/werkstatt/articles/lookup",
        params={"code": code},
        headers=auth_headers(token),
    )
    assert response.status_code == 200, response.text
    return response.json()


# ──────────────────────────────────────────────────────────────────────────
# Ours first, always
# ──────────────────────────────────────────────────────────────────────────


def test_an_article_we_stock_stops_the_cascade(client: TestClient, admin_token: str, shop):
    """The whole point: never create a second row for something on the shelf."""
    handler = shop(_product_page(EAN13))
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Schuko-Steckdose", "ean": EAN13, "unit": "Stk"},
    )
    assert created.status_code == 200, created.text

    found = _lookup(client, admin_token, EAN13)
    assert found["kind"] == "existing"
    assert found["article"]["article_number"] == created.json()["article_number"]
    assert found["matched_by"] == "ean"
    # Nothing left the building for a code we already knew.
    assert handler.requests == []


def test_a_upc_scan_finds_the_ean_13_row(client: TestClient, admin_token: str, shop):
    """The duplicate this prevents is the one the merge screen has to clean up."""
    shop(None)
    client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Importwerkzeug", "ean": UPCA_AS_EAN13},
    )
    found = _lookup(client, admin_token, UPCA)
    assert found["kind"] == "existing"
    assert found["article"]["ean"] == UPCA_AS_EAN13


def test_creating_with_the_other_spelling_is_refused_in_german(
    client: TestClient, admin_token: str
):
    client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Importwerkzeug", "ean": UPCA_AS_EAN13},
    )
    clash = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Dasselbe nochmal", "ean": UPCA},
    )
    assert clash.status_code == 400
    detail = clash.json()["detail"]
    assert "Importwerkzeug" in detail and "SP-" in detail


def test_the_catalogue_answers_before_the_webshop(client: TestClient, admin_token: str, shop):
    handler = shop(_product_page(EAN13))
    supplier = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(admin_token), json={"name": "Unielektro"}
    ).json()["id"]
    _catalog_row(supplier, article_no="A-111", ean=EAN13, name="Schuko Steckdose")

    found = _lookup(client, admin_token, EAN13)
    assert found["kind"] == "catalog"
    assert found["groups"][0]["hero"]["article_no"] == "A-111"
    assert handler.requests == []


# ──────────────────────────────────────────────────────────────────────────
# The world outside — and the checks that make it usable
# ──────────────────────────────────────────────────────────────────────────


def test_a_webshop_hit_becomes_a_suggestion_with_its_source(
    client: TestClient, admin_token: str, shop
):
    shop(_product_page(EAN13))
    found = _lookup(client, admin_token, EAN13)
    assert found["kind"] == "external"
    assert found["hit"]["item_name"] == "Schuko-Steckdose reinweiß"
    assert found["hit"]["manufacturer"] == "Gira"
    assert found["hit"]["unit"] == "Stk"
    assert found["hit"]["ean"] == EAN13
    # Provenance travels with the suggestion: a scrape is a guess, and hiding
    # where it came from makes it look like a fact.
    assert found["hit"]["source"] == "unielektro_shop"
    assert found["hit"]["source_url"].startswith("https://www.unielektro.de")


def test_a_page_about_a_different_product_is_refused(
    client: TestClient, admin_token: str, shop
):
    """The failure that would matter: a confident, wrong name on a shelf label."""
    shop(_product_page("4012345678918", name="Ganz anderes Produkt"))
    found = _lookup(client, admin_token, EAN13)
    assert found["kind"] == "none"
    assert found.get("external_skipped") is None


def test_a_miss_is_cached_so_the_rack_does_not_rescrape(
    client: TestClient, admin_token: str, shop
):
    handler = shop(None, status=404)
    assert _lookup(client, admin_token, EAN13)["kind"] == "none"
    calls_after_first = len(handler.requests)
    assert calls_after_first > 0

    assert _lookup(client, admin_token, EAN13)["kind"] == "none"
    assert len(handler.requests) == calls_after_first

    with SessionLocal() as db:
        row = db.get(WerkstattEanLookup, EAN13)
        assert row is not None and row.miss is True


def test_a_hit_is_cached_under_its_ean_13_spelling(client: TestClient, admin_token: str, shop):
    handler = shop(_product_page(UPCA_AS_EAN13))
    first = _lookup(client, admin_token, UPCA)
    assert first["kind"] == "external"
    calls = len(handler.requests)

    # The zero-padded spelling is the same barcode and must hit the same row.
    second = _lookup(client, admin_token, UPCA_AS_EAN13)
    assert second["kind"] == "external"
    assert len(handler.requests) == calls
    with SessionLocal() as db:
        assert db.get(WerkstattEanLookup, UPCA_AS_EAN13) is not None


def test_a_code_that_is_not_a_barcode_never_leaves_the_building(
    client: TestClient, admin_token: str, shop
):
    handler = shop(_product_page(EAN13))
    found = _lookup(client, admin_token, "Regal B2 links")
    assert found["kind"] == "none"
    assert found["external_skipped"] == "not_a_gtin"
    assert handler.requests == []


def test_switching_the_scraper_off_says_so(
    client: TestClient, admin_token: str, shop, monkeypatch
):
    from app.core.config import get_settings

    handler = shop(_product_page(EAN13))
    monkeypatch.setattr(get_settings(), "ean_lookup_unielektro_enabled", False, raising=False)
    found = _lookup(client, admin_token, EAN13)
    assert found["kind"] == "none"
    assert found["external_skipped"] == "disabled"
    assert handler.requests == []


def test_allow_external_false_stays_inside(client: TestClient, admin_token: str, shop):
    handler = shop(_product_page(EAN13))
    response = client.get(
        "/api/werkstatt/articles/lookup",
        params={"code": EAN13, "allow_external": "false"},
        headers=auth_headers(admin_token),
    )
    assert response.status_code == 200
    # NOT "disabled": the caller asked for a cheap answer, the configuration
    # is untouched, and telling the workshop the webshop search is switched
    # off would send somebody to edit .env over this request's own choice.
    assert response.json()["external_skipped"] == "not_requested"
    assert handler.requests == []


def test_private_hosts_are_refused_by_the_real_guard():
    """The SSRF guard is the one thing the fake shop must not paper over.

    ``fetch_text`` is called with the genuine ``is_public_http_url`` here, so a
    loopback URL — the shape an open redirect or a poisoned search result would
    take — is refused before any socket is opened.
    """
    budget = ean_http.Budget.start(2.0)
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text="x"))) as c:
        assert ean_http.fetch_text(c, "http://127.0.0.1/admin", budget) is None
        assert ean_http.fetch_text(c, "http://localhost/admin", budget) is None
        assert ean_http.fetch_text(c, "file:///etc/passwd", budget) is None


def test_an_exhausted_budget_stops_the_cascade():
    """A slow shop costs one slow request, never a wedged worker."""
    budget = ean_http.Budget.start(0.5)
    budget.started_at -= 10  # pretend ten seconds have passed
    assert budget.exhausted
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text="x"))) as c:
        assert ean_http.fetch_text(c, "https://www.unielektro.de/x", budget) is None


# ──────────────────────────────────────────────────────────────────────────
# Creating from a suggestion
# ──────────────────────────────────────────────────────────────────────────


def test_an_accepted_suggestion_records_where_it_came_from(
    client: TestClient, admin_token: str
):
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={
            "item_name": "Schuko-Steckdose reinweiß",
            "ean": EAN13,
            "unit": "Stk",
            "image_source": "external",
            "lookup_source": "unielektro_shop",
            "stock_total": 4,
        },
    )
    assert created.status_code == 200, created.text
    article = created.json()
    assert "unielektro_shop" in (article["notes"] or "")
    assert article["image_source"] == "external"
    # Stock comes from the ledger, never from an assignment.
    assert article["stock_total"] == 4

    with SessionLocal() as db:
        row = db.scalars(
            select(WerkstattArticle).where(WerkstattArticle.id == article["id"])
        ).first()
        assert row.is_serialized is False


def test_lookup_needs_no_manage_permission(client: TestClient, admin_token: str, shop):
    """The person holding the unfamiliar box is rarely the one with rights."""
    shop(None)
    created = client.post(
        "/api/admin/users",
        headers=auth_headers(admin_token),
        json={
            "email": "lager@example.com",
            "password": "Password123!",
            "full_name": "Lager",
            "role": "employee",
        },
    )
    assert created.status_code == 200, created.text
    token = client.post(
        "/api/auth/login", json={"email": "lager@example.com", "password": "Password123!"}
    ).headers["X-Access-Token"]

    response = client.get(
        "/api/werkstatt/articles/lookup",
        params={"code": "SP-9999"},
        headers=auth_headers(token),
    )
    assert response.status_code == 200, response.text


def test_an_archived_ean_offers_reactivation_instead_of_a_bare_400(
    client: TestClient, admin_token: str
):
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Alte Dose", "ean": EAN13},
    ).json()
    client.delete(
        f"/api/werkstatt/articles/{created['id']}", headers=auth_headers(admin_token)
    )

    clash = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Neue Dose", "ean": EAN13},
    )
    assert clash.status_code == 400
    assert "Reaktivieren" in clash.json()["detail"]

    # And the route the message names actually exists.
    revived = client.patch(
        f"/api/werkstatt/articles/{created['id']}",
        headers=auth_headers(admin_token),
        json={"is_archived": False},
    )
    assert revived.status_code == 200, revived.text
    assert revived.json()["is_archived"] is False


# ──────────────────────────────────────────────────────────────────────────
# The list the Bestand page reads
# ──────────────────────────────────────────────────────────────────────────


def test_kind_filter_separates_consumables_from_machine_types(
    client: TestClient, admin_token: str
):
    head = auth_headers(admin_token)
    client.post(
        "/api/werkstatt/articles", headers=head, json={"item_name": "Kabelbinder", "unit": "Pak"}
    )
    client.post(
        "/api/werkstatt/articles",
        headers=head,
        json={"item_name": "Bohrhammer", "is_serialized": True},
    )

    consumables = client.get(
        "/api/werkstatt/articles", params={"kind": "consumable"}, headers=head
    ).json()
    machines = client.get(
        "/api/werkstatt/articles", params={"kind": "machine"}, headers=head
    ).json()
    everything = client.get("/api/werkstatt/articles", headers=head).json()

    assert [row["item_name"] for row in consumables] == ["Kabelbinder"]
    assert [row["item_name"] for row in machines] == ["Bohrhammer"]
    assert len(everything) == 2
    # The row says which world it belongs to, so a filtered list can still
    # explain itself per row.
    assert consumables[0]["is_serialized"] is False
    assert machines[0]["is_serialized"] is True


# ──────────────────────────────────────────────────────────────────────────
# Where a name is allowed to come from
# ──────────────────────────────────────────────────────────────────────────


def test_a_result_listing_may_never_name_an_article(
    client: TestClient, admin_token: str, shop
):
    """The failure this closes: an article called "Suchergebnis für 4012…".

    A Shopware result page renders the matching product's barcode in microdata
    and carries the QUERY in its og:title. "The page states our GTIN" was the
    whole acceptance test, and the name was then taken from a tag that has
    nothing to do with the product — unreviewed on the station path, where it
    becomes a shelf label that sends the next person to the wrong bin.
    """
    shop(
        None,
        pages={
            SEARCH_URL: (200, _listing_page(EAN13)),
            NAVIGATOR_URL: (404, "nope"),
        },
    )
    found = _lookup(client, admin_token, EAN13)
    assert found["kind"] == "none"


def test_a_listing_is_followed_to_the_product_page_it_links_to(
    client: TestClient, admin_token: str, shop
):
    """It is still the cheapest way in — as a source of links, not of names."""
    shop(
        None,
        pages={
            SEARCH_URL: (200, _listing_page(EAN13, LINKED_PRODUCT_URL)),
            NAVIGATOR_URL: (404, "nope"),
            LINKED_PRODUCT_URL: (200, _microdata_page(EAN13, "WAGO 221-413 Klemme")),
        },
    )
    found = _lookup(client, admin_token, EAN13)
    assert found["kind"] == "external"
    # Out of the Product scope that carried the barcode, not off the page.
    assert found["hit"]["item_name"] == "WAGO 221-413 Klemme"
    assert found["hit"]["manufacturer"] == "WAGO"
    assert found["hit"]["image_url"] == "https://www.unielektro.de/img/wago.jpg"


def test_a_page_stating_several_barcodes_is_not_one_product(
    client: TestClient, admin_token: str, shop
):
    """One product page states one barcode; a page stating two is a list."""
    shop(
        None,
        pages={
            SEARCH_URL: (302, LINKED_PRODUCT_URL),
            NAVIGATOR_URL: (404, "nope"),
            LINKED_PRODUCT_URL: (
                200,
                _microdata_page(EAN13, "WAGO 221-413 Klemme", extra_gtin="4012345678918"),
            ),
        },
    )
    assert _lookup(client, admin_token, EAN13)["kind"] == "none"


def test_the_shop_is_asked_before_any_web_search(client: TestClient, admin_token: str, shop):
    """Two Bing round trips used to be spent BEFORE the first shop page.

    With a six-second budget that routinely left nothing for the product page,
    so a product the wholesaler describes perfectly well answered "nichts
    gefunden" — and the miss was cached for a day.
    """
    handler = shop(_product_page(EAN13))
    assert _lookup(client, admin_token, EAN13)["kind"] == "external"
    assert not any("bing.com" in url for url in handler.requests)


def test_an_unreadable_unit_code_is_dropped_rather_than_printed(
    client: TestClient, admin_token: str, shop
):
    """"14 C62" on a Bestand row tells nobody whether that is pieces or metres."""
    page = _product_page(EAN13).replace('"unitText": "Stk"', '"unitCode": "MTR"')
    shop(page)
    assert _lookup(client, admin_token, EAN13)["hit"]["unit"] == "m"

    with SessionLocal() as db:
        row = db.get(WerkstattEanLookup, EAN13)
        db.delete(row)
        db.commit()

    unknown = _product_page(EAN13).replace('"unitText": "Stk"', '"unitCode": "XYZ"')
    shop(unknown)
    assert _lookup(client, admin_token, EAN13)["hit"]["unit"] is None


def test_a_provider_url_that_is_not_public_http_is_dropped():
    """Runs the REAL guard: these are refused before any socket is opened.

    ``opengtindb`` is community-submitted and the one provider an operator can
    switch on without a key, so its ``origin`` field is third-party-writable —
    and it is rendered as the href of "Quelle ansehen" in an authenticated
    session and as an image src in the office browser.
    """
    from app.services.ean_lookup.base import build_hit

    hit = build_hit(
        ean=EAN13,
        item_name="Irgendwas",
        source="opengtindb",
        source_url="javascript:alert(document.cookie)",
        image_url="http://192.168.2.50/admin.png",
    )
    assert hit is not None
    assert hit.source_url is None
    assert hit.image_url is None


# ──────────────────────────────────────────────────────────────────────────
# Ours first — across the spellings, not only inside one
# ──────────────────────────────────────────────────────────────────────────


def test_an_article_on_another_spelling_beats_a_catalogue_row(
    client: TestClient, admin_token: str, shop
):
    """Otherwise the dialog offers to create something already on the shelf.

    The article carries the 13-digit EAN, a second supplier's Datanorm row
    carries its 12-digit UPC-A twin, and the scanner emits the 12-digit form.
    Walking the variants and taking the first non-empty cascade answer found
    the CATALOGUE on variant one and never reached the article on variant two.
    """
    shop(None)
    supplier = client.post(
        "/api/werkstatt/suppliers", headers=auth_headers(admin_token), json={"name": "Zweiter"}
    ).json()["id"]
    _catalog_row(supplier, article_no="Z-1", ean=UPCA, name="Importwerkzeug (Katalog)")
    created = client.post(
        "/api/werkstatt/articles",
        headers=auth_headers(admin_token),
        json={"item_name": "Importwerkzeug", "ean": UPCA_AS_EAN13},
    )
    assert created.status_code == 200, created.text

    found = _lookup(client, admin_token, UPCA)
    assert found["kind"] == "existing"
    assert found["article"]["article_number"] == created.json()["article_number"]


# ──────────────────────────────────────────────────────────────────────────
# The cache, and what it is allowed to cost
# ──────────────────────────────────────────────────────────────────────────


def test_expired_cache_rows_are_dropped_when_a_new_one_is_written(
    client: TestClient, admin_token: str, shop
):
    """Otherwise the table grows one row per distinct barcode, for ever.

    The endpoint needs no manage permission and check digits are trivially
    computable, so "every GTIN anyone ever scanned" is unbounded — inside the
    database the backups carry.
    """
    from datetime import timedelta

    from app.core.time import utcnow

    with SessionLocal() as db:
        db.add(
            WerkstattEanLookup(
                ean="4006381333931",
                miss=True,
                fetched_at=utcnow() - timedelta(days=9),
            )
        )
        db.commit()

    shop(_product_page(EAN13))
    assert _lookup(client, admin_token, EAN13)["kind"] == "external"

    with SessionLocal() as db:
        assert db.get(WerkstattEanLookup, "4006381333931") is None
        assert db.get(WerkstattEanLookup, EAN13) is not None


def test_the_web_search_is_read_through_the_same_capped_transport(
    client: TestClient, admin_token: str, shop
):
    """The one fetch in this package that used to have no size limit.

    ``material_catalog_images.bing_search_links`` reads the whole response into
    memory and runs a regex over it — on a container capped at 1500 MB with
    swap off that has been OOM-killed before. Routed through ``fetch_text`` the
    body is streamed and cut at 1 MiB, which a link parked past the cap proves.
    """
    padding = "<!--" + ("x" * (2 * 1024 * 1024)) + "-->"
    rss = f"<rss>{padding}<link>{LINKED_PRODUCT_URL}</link></rss>"
    handler = shop(
        None,
        pages={
            SEARCH_URL: (404, "nope"),
            NAVIGATOR_URL: (404, "nope"),
            "https://www.bing.com/search?format=rss&q=site%3Aunielektro.de+4012345678901": (
                200,
                rss,
            ),
            "https://www.bing.com/search?format=rss&q=site%3Ashop.unielektro.de+4012345678901": (
                200,
                rss,
            ),
            LINKED_PRODUCT_URL: (200, _microdata_page(EAN13, "WAGO 221-413 Klemme")),
        },
    )
    assert _lookup(client, admin_token, EAN13)["kind"] == "none"
    # The search WAS made; the link beyond the cap simply never arrived.
    assert any("bing.com" in url for url in handler.requests)
    assert LINKED_PRODUCT_URL not in handler.requests


def test_each_request_gets_what_is_left_of_the_budget_not_all_of_it():
    """A cascade used to run roughly twice the configured budget.

    ``build_client`` fixed every request's read timeout at the FULL budget, so
    a request begun with 0.3 s left still ran its own six seconds — which is
    what outlived the scan station's own timeout and left the wall saying
    "nicht angelegt" for a delivery the server had booked.
    """
    budget = ean_http.Budget.start(6.0)
    assert budget.timeout().read == pytest.approx(6.0, abs=0.2)
    budget.started_at -= 5.0
    assert budget.timeout().read == pytest.approx(1.0, abs=0.2)
