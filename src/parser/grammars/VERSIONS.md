# Vendored tree-sitter grammars

Extracted from the npm package tarballs (`npm pack <pkg>@<version>`); only the `.wasm` file is kept.
Loaded by `web-tree-sitter` 0.27 (`Language.load(path)`).

| File | Package | Version |
|---|---|---|
| tree-sitter-typescript.wasm | tree-sitter-typescript | 0.23.2 |
| tree-sitter-tsx.wasm | tree-sitter-typescript | 0.23.2 |
| tree-sitter-javascript.wasm | tree-sitter-javascript | 0.25.0 |
| tree-sitter-python.wasm | tree-sitter-python | 0.25.0 |
| tree-sitter-go.wasm | tree-sitter-go | 0.25.0 |

To upgrade: `npm pack <pkg>@<new>` in a scratch dir, extract the `.wasm`, replace it here, update this table,
and run `npm test` (the parser tests load every grammar).
