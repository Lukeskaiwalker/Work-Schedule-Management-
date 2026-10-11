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
  labourTitle: string;
  labourEmpty: string;
  labourTotal: string;
  labourRunning: string;
  labourStale: string;
  labourEnd: string;
  labourEndAt: string;
  labourEndConfirm: string;
  labourEndFailed: string;
  labourSessions: (count: number) => string;
  searchResults: string;
  pdf: string;
  pdfTitle: string;
  addMaterial: string;
  addSearchLabel: string;
  addSearchPlaceholder: string;
  freeTextHint: (text: string) => string;
  pickedArticle: string;
  pickAnother: string;
  quantity: string;
  note: string;
  notePlaceholder: string;
  quantityInvalid: string;
  addSubmit: string;
  close: string;
  added: (label: string) => string;
  addFailed: string;
  manual: string;
  freeText: string;
  editManual: string;
  editManualTitle: string;
  editManualForm: (label: string) => string;
  save: string;
  removeManual: string;
  removeManualTitle: string;
  manualFailed: string;
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
  labourTitle: "Arbeitszeit",
  labourEmpty: "Noch keine Arbeitszeit. Am Regal den Verteiler scannen, dann den eigenen Ausweis.",
  labourTotal: "gesamt",
  labourRunning: "läuft seit",
  labourStale: "Ausstempeln vergessen?",
  labourEnd: "Beenden",
  labourEndAt: "Ende",
  labourEndConfirm: "Speichern",
  labourEndFailed: "Arbeitszeit konnte nicht beendet werden.",
  labourSessions: (count) => (count === 1 ? "1 Einsatz" : `${count} Einsätze`),
  searchResults: "Gefundene Lagerartikel",
  pdf: "Als PDF",
  pdfTitle: "Die Materialliste als PDF öffnen — zum Drucken oder Weitergeben",
  addMaterial: "Material hinzufügen",
  addSearchLabel: "Lagerartikel suchen oder Freitext",
  addSearchPlaceholder: "Lagerartikel suchen oder Freitext eingeben…",
  freeTextHint: (text) => `Ohne Auswahl wird „${text}“ als Freitext übernommen.`,
  pickedArticle: "Lagerartikel",
  pickAnother: "Andere Auswahl",
  quantity: "Menge",
  note: "Notiz",
  notePlaceholder: "optional, z. B. für Reihe 2",
  quantityInvalid: "Menge: eine ganze Zahl von 1 bis 9999.",
  addSubmit: "Hinzufügen",
  close: "Schließen",
  added: (label) => `„${label}“ hinzugefügt.`,
  addFailed: "Material konnte nicht hinzugefügt werden.",
  manual: "manuell",
  freeText: "Freitext — kein Lagerartikel",
  editManual: "Ändern",
  editManualTitle: "Menge oder Notiz ändern",
  editManualForm: (label) => `${label} ändern`,
  save: "Speichern",
  removeManual: "Entfernen",
  removeManualTitle: "Aus der Liste nehmen — schon gebuchte Stücke bleiben gebucht",
  manualFailed: "Die Position konnte nicht geändert werden.",
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
  labourTitle: "Labour",
  labourEmpty: "No time booked yet. At the rack, scan the board, then your own badge.",
  labourTotal: "total",
  labourRunning: "running since",
  labourStale: "Forgot to clock out?",
  labourEnd: "End",
  labourEndAt: "End",
  labourEndConfirm: "Save",
  labourEndFailed: "Could not end the session.",
  labourSessions: (count) => (count === 1 ? "1 session" : `${count} sessions`),
  searchResults: "Matching stock articles",
  pdf: "As PDF",
  pdfTitle: "Open the material list as a PDF — to print or pass on",
  addMaterial: "Add material",
  addSearchLabel: "Search stock articles or free text",
  addSearchPlaceholder: "Search stock articles or type free text…",
  freeTextHint: (text) => `Without a pick, “${text}” is added as free text.`,
  pickedArticle: "Stock article",
  pickAnother: "Pick another",
  quantity: "Quantity",
  note: "Note",
  notePlaceholder: "optional, e.g. for row 2",
  quantityInvalid: "Quantity: a whole number from 1 to 9999.",
  addSubmit: "Add",
  close: "Close",
  added: (label) => `“${label}” added.`,
  addFailed: "The material could not be added.",
  manual: "by hand",
  freeText: "Free text — no stock article",
  editManual: "Edit",
  editManualTitle: "Change quantity or note",
  editManualForm: (label) => `Edit ${label}`,
  save: "Save",
  removeManual: "Remove",
  removeManualTitle: "Take it off the list — pieces already booked stay booked",
  manualFailed: "The line could not be changed.",
};

export function materialTexts(language: "de" | "en"): MaterialTexts {
  return language === "de" ? DE : EN;
}
