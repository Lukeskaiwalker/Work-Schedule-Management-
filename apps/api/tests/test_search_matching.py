"""Unit tests for the shared search-matching helpers.

These cover the three concrete ways search used to miss an article that was
sitting in the catalog: no tokenisation, decimal-separator drift between
Datanorm suppliers, and punctuation drift in article numbers.
"""

from app.services.search_matching import (
    identifier_key,
    normalize_query,
    term_variants,
    tokenize,
)


def test_tokenize_splits_on_whitespace_and_folds_case():
    assert tokenize("  NYM-J   3x1,5  ") == ["nym-j", "3x1,5"]


def test_tokenize_empty_query_yields_no_tokens():
    assert tokenize("") == []
    assert tokenize("    ") == []


def test_normalize_query_collapses_runs_of_whitespace():
    assert normalize_query("Schuko\t Steckdose\n weiss") == "schuko steckdose weiss"


def test_term_variants_covers_both_decimal_spellings():
    """A wholesaler writes 3x1,5; another writes 3x1.5. Either must find both."""
    assert set(term_variants("3x1,5")) == {"3x1,5", "3x1.5"}
    assert set(term_variants("3x1.5")) == {"3x1.5", "3x1,5"}


def test_term_variants_leaves_plain_tokens_alone():
    """No separator to swap means exactly one clause, not a pointless OR."""
    assert term_variants("schuko") == ["schuko"]


def test_term_variants_does_not_touch_thousands_style_commas_in_words():
    # Only digit,digit is rewritten - a comma between letters is not a decimal.
    assert term_variants("abc,def") == ["abc,def"]


def test_identifier_key_strips_punctuation():
    """1234-567, 1234.567 and 1234 567 all name the same article."""
    assert identifier_key("1234-567") == "1234567"
    assert identifier_key("1234.567") == "1234567"
    assert identifier_key("1234 567") == "1234567"
    assert identifier_key("NYM-J") == "nymj"


def test_identifier_key_of_punctuation_only_is_empty():
    """Guards the exact-match path from treating '---' as matching everything."""
    assert identifier_key("---") == ""
