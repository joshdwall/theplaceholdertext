# Vendored UI

Do not rewrite the vendor files. Pages use Bootstrap classes only.

| File | Source | Version |
|---|---|---|
| `public/vendor/bootswatch/minty/bootstrap.min.css` | Bootswatch Minty (full Bootstrap build) | 5.3.3 |
| `public/theme/moss.css` | Variable retint on top of Minty | site |
| `public/vendor/bootstrap/bootstrap.bundle.min.js` | Bootstrap bundle | 5.3.3 |
| `public/vendor/bootstrap-icons/` | Bootstrap Icons | 1.11.3 |
| `public/vendor/fonts/bricolage-grotesque/` | Bricolage Grotesque (SIL OFL) | 5.2.8 |
| `public/vendor/fonts/literata/` | Literata (SIL OFL) | 5.2.8 |
| `public/vendor/fonts/source-serif-4/` | Source Serif 4 (SIL OFL) | 5.2.8 |
| `public/media/moss-rocks.jpg` | Marianne Gagnon, public domain | — |

Which font is on the page is `font` in `public/config/site.json`, not a code change.

The live page does not load Bootstrap. `public/theme/moss.css` is the page design. The Bootstrap files stay in `vendor/` from the earlier build.
