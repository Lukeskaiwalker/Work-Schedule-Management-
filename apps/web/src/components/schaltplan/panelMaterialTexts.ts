/**
 * Every sentence the Materialliste says, in both languages. German is the
 * product's language; the English set exists because the list also sits on
 * the Werkstatt page, which branches on `language` everywhere else.
 */

export type MaterialTexts = {
  loading: string;
  loadFailed: string;
  retry: string;
  empty: string;
  listLabel: string;
  done: string;
  over: string;
  unplanned: string;
  noArticle: string;
  assign: string;
  change: string;
  remove: string;
  auto: string;
  autoTitle: string;
  stock: string;
  searchLabel: string;
  searchPlaceholder: string;
  searchHint: string;
  searching: string;
  searchEmpty: string;
  searchFailed: string;
  cancel: string;
  bookFailed: string;
  mappingFailed: string;
  bookOne: string;
  unbookOne: string;
  scannedOfPlanned: string;
  lastScanned: string;
  openLines: (count: number) => string;
};

const DE: MaterialTexts = {
  loading: "Materialliste wird geladen…",
  loadFailed: "Materialliste konnte nicht geladen werden.",
  retry: "Erneut versuchen",
  empty: "Noch kein Material: die Liste entsteht aus den Geräten im Aufbau des Verteilers.",
  listLabel: "Materialliste",
  done: "vollständig",
  over: "zu viel",
  unplanned: "nicht geplant",
  noArticle: "Kein Lagerartikel zugeordnet",
  assign: "Artikel zuordnen",
  change: "Zuordnung ändern",
  remove: "Zuordnung entfernen",
  auto: "auto",
  autoTitle: "Automatisch erkannt — die Artikelnummer steht am Anfang des Artikelnamens",
  stock: "Bestand",
  searchLabel: "Lagerartikel suchen",
  searchPlaceholder: "Artikel suchen (Name oder SP-Nummer)…",
  searchHint: "Mindestens 2 Zeichen eingeben.",
  searching: "Suche…",
  searchEmpty: "Kein Lagerartikel gefunden.",
  searchFailed: "Artikelsuche fehlgeschlagen.",
  cancel: "Abbrechen",
  bookFailed: "Buchung fehlgeschlagen.",
  mappingFailed: "Zuordnung konnte nicht gespeichert werden.",
  bookOne: "Ein Stück für diesen Verteiler buchen",
  unbookOne: "Eine Buchung zurücknehmen",
  scannedOfPlanned: "gescannt",
  lastScanned: "zuletzt gescannt",
  openLines: (count) => (count === 1 ? "1 offen" : `${count} offen`),
};

const EN: MaterialTexts = {
  loading: "Loading material list…",
  loadFailed: "The material list could not be loaded.",
  retry: "Try again",
  empty: "No material yet: the list follows from the devices on the panel's rails.",
  listLabel: "Material list",
  done: "complete",
  over: "too many",
  unplanned: "not planned",
  noArticle: "No stock article assigned",
  assign: "Assign article",
  change: "Change assignment",
  remove: "Remove assignment",
  auto: "auto",
  autoTitle: "Matched automatically — the part number opens the article's name",
  stock: "Stock",
  searchLabel: "Search stock articles",
  searchPlaceholder: "Search articles (name or SP number)…",
  searchHint: "Type at least 2 characters.",
  searching: "Searching…",
  searchEmpty: "No stock article found.",
  searchFailed: "Article search failed.",
  cancel: "Cancel",
  bookFailed: "Booking failed.",
  mappingFailed: "The assignment could not be saved.",
  bookOne: "Book one piece for this panel",
  unbookOne: "Take one booking back",
  scannedOfPlanned: "scanned",
  lastScanned: "last scanned",
  openLines: (count) => (count === 1 ? "1 open" : `${count} open`),
};

export function materialTexts(language: "de" | "en"): MaterialTexts {
  return language === "de" ? DE : EN;
}
