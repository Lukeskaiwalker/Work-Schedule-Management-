# Sample documents for v2.4.0 line-item extraction

Real PDFs / images go in the per-doctype subfolders below. Everything in
this tree (except the README files and the `.gitignore`) is gitignored so
real customer data never accidentally hits the public repo.

## Where to put what

| Doctype | Folder | Description |
|---|---|---|
| **Auftragsbestätigung** | `auftragsbestaetigung/` | What the customer signed — your binding scope |
| **Bestellbestätigung** | `bestellbestaetigung/` | What the supplier sends YOU after you place an order |
| **Lieferschein** | `lieferschein/` | What ships with the actual physical delivery |

## How many samples

For productive prompt engineering we need at least:
- **3 Auftragsbestätigungen** of varying complexity (small/medium/large project)
- **3 Lieferscheine** from your most-used 3 suppliers (so we cover format variation)
- **2 Bestellbestätigungen** if you have them handy (lower priority — smaller doctype)

A few really-good samples beats many mediocre ones; pick documents that
represent the breadth of variation you actually see in operations.

## Privacy note

These files are **never committed** — they live only on your local working
copy and on whatever development machines we explicitly copy them to. The
`.gitignore` in this folder enforces this. If you ever need to share a
sample externally, redact:
- customer name + address
- contact phone / email
- any internal pricing you don't want to share

But for working with me locally, no redaction needed — I read them only
to design the extraction prompts and never persist them outside this folder.
