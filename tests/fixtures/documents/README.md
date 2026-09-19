# Synthetic document fixtures

`word.doc` and `word.docx` were generated from `word.txt` using macOS TextEdit's
`textutil` converter. They contain only synthetic preview acceptance text, with
Polish characters and an identifier containing leading zeroes. The `.doc` file
uses the binary Word container; `.docx` uses OOXML.

Regenerate on macOS:

```sh
textutil -convert doc tests/fixtures/documents/word.txt -output tests/fixtures/documents/word.doc
textutil -convert docx tests/fixtures/documents/word.txt -output tests/fixtures/documents/word.docx
```

The Excel fixtures are generated in-memory in `document-preview.test.mjs`.

`markdown.md` exercises headings, GFM tables and task lists, code blocks, Unicode,
safe external links, and inert HTML/unsafe URLs in the shared Markdown preview.
It contains only synthetic text and example.com references.
