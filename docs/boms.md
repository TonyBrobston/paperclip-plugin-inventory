# BOMs: the file format, versioning, and what reaches the public docs

What a kit contains usually lives in prose — a bullet list in an install
document nobody checks against real parts. Nothing versions it, and a quantity
edited today silently changes what yesterday's sales are believed to have
consumed. A BOM file fixes that: one YAML file per product in the private
config repository, synced into immutable versions, expanded on every sale.

This document is the plugin's half. The file format's own reference lives next
to the files, in the config repository's `docs/bom-schema.md`.

## The file

```yaml
catalog_key: product-127          # or a variant SKU, e.g. KIT-139-IN
status: active                    # active | draft
install_document: install-instructions/Example-Kit-Install-Instructions.MD
source_revision: a60cb3cd…        # the documentation commit this was converted from
lines:
  - part: vendor-a:part-001       # must already exist in `parts`
    qty: 8
    customer_description: "Countersunk screws (for the shelf)"
    source_line_id: example-kit:01
options:
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "Rocker"
    lines:
      - part: vendor-b:part-010
        qty: 1
        customer_description: "Rocker switch plate"
  - bigcommerce_option: "Which switch type do you have?"
    option_value: "None"
    lines: []                     # a real answer: this value consumes nothing
```

Two shapes differ from the provisional schema in phase 1, both because the live
catalog disagreed with it.

**A BOM hangs on a catalog key, not a SKU.** Every product-level SKU in this
catalog is empty — SKUs exist only on variants, and only where a product has
options. A BOM keyed on an empty string resolves to nothing, so a sale of it
consumes nothing and the ledger looks healthy while it happens. The key is
therefore a variant SKU where one exists and `product-<BigCommerce product id>`
where one does not, the file name has to match it, and `sync_boms` resolves it
against the store before accepting the file.

**An option line carries a name and a value.** "Which macerator switch type do
you have?" has three values with a different part behind each, so a name alone
cannot say which to consume. Both halves are required, and a value that
consumes nothing is still declared — otherwise, at sale time, "this value adds
no parts" and "nobody has written this value down" would be the same answer,
and the second one is an option renamed in the storefront.

## Drafts

A `status: draft` file carries the documented quantities and customer
descriptions with the part mappings still open. Every unresolved line says why:

```yaml
  - qty: 4
    customer_description: "Cap head screws (for the induction cooktop mounts)"
    pending:
      - "part unresolved: two purchased candidates, neither confirmed"
```

`sync_boms` validates a draft's shape and its catalog key, reports it, and
imports none of it. Activation is removing the word `draft` and supplying every
`part`, which the validator in the config repository enforces and a reviewer
sees as a diff. A file cannot be half-activated: an active BOM with a `pending`
line is refused, and a draft with nothing pending is refused too — otherwise a
finished BOM sits inert because nobody noticed the word at the top of the file.

This is why the documented kit lists live in `bom/` before anyone has confirmed
a single part: they are reviewable where BOMs live, and inert by construction
rather than by convention.

## Versions

`sync_boms` is the only writer. It reads one commit, validates everything, and
writes nothing at all if anything fails — a partial import would leave some
products expanding against a new version and others against an old one, with
no record of which.

- A version is **content**, not a file. The hash covers the key, the lines and
  the option scopes; reformatting a file or editing a comment imports nothing,
  and changing a quantity inserts a new version.
- Versions are **immutable**: triggers refuse `UPDATE`, `DELETE` and
  `TRUNCATE` on `boms` and `bom_lines`. A sale that expanded against version 2
  keeps pointing at version 2 forever.
- The active version is the highest one. A file demoted to draft does not
  retract it — the sync says so instead, because that product is still
  consuming parts on every sale.

`record_sale` reads the active version inside the sale's own transaction,
writes the version id into each entry's provenance, and consumes every line or
none of them. It makes no catalog call: an outage at BigCommerce must not stop
the ledger from recording something that physically shipped.

## What may reach the public documentation repository

`customer_description` and a quantity. Nothing else, ever — not a part
reference, not a vendor name, not a vendor part number.

The generator is a command rather than a tool, because rewriting a public
repository is a reviewed pull request and not something an agent does
mid-conversation:

```bash
npm run build
node dist/install-docs-cli.js --config ../config-repo --docs ../documentation
node dist/install-docs-cli.js --config ../config-repo --docs ../documentation --write
```

Dry by default. It has no credentials, does not commit and does not push: it
leaves a working tree for a human to diff and open a pull request from.

Its refusals are the acceptance criterion in code:

- Only the bullet run directly beneath
  `### Brackets and fasteners included in the kit:` is rewritten, and the run
  ends at the first line that is neither a bullet nor blank. The next heading,
  the kit photo and every installation step are out of range by construction.
- `### Not included in the kit:` is never touched. It lists what the customer
  supplies, which is not a BOM line.
- A document with no anchor, or with two, is refused rather than guessed at.
- Option-scoped lines are left out: they are not in every kit.
- A vendor name or anything shaped like a vendor part number aborts the whole
  write. The check is narrow enough to leave the specifications a customer
  needs — `M6 x 25mm cap head allen bolts`, `10mm ball studs 5/16-18 x 1/2` —
  untouched.
- A draft is refused, because publishing from one would present an unreviewed
  kit list as final.

## Configuration

| Setting | Required for | What it is |
|---|---|---|
| Private config repository | `sync_boms` | `owner/name` of the repository holding `bom/`. |
| Config repository branch | no | Blank means the repository's default branch. |
| GitHub token | `sync_boms` | A Paperclip secret with read access to that repository. Only `bom/` is ever requested. |
| BigCommerce store hash | `sync_boms` | Used to resolve catalog keys and option values. |
| BigCommerce API token | `sync_boms` | A Paperclip secret with read access to products. The sync only reads. |

Both tokens are secret references resolved per call, never stored in plugin
config and never written to a log or an error message.
