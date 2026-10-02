# Anticlus site

One static page: `index.html`. Inline CSS, no JavaScript, no build step, no external requests.

## Preview

Open the file directly:

```bash
open site/index.html
```

Or serve it locally:

```bash
python3 -m http.server 8080 --directory site
# then open http://localhost:8080
```

## Deploy

Upload the `site/` folder to any static host (GitHub Pages, Netlify, Cloudflare Pages, an S3 bucket, any web server). There is nothing to build. `index.html` is the whole site.

## Placeholders to change

Both values below are placeholders. Search and replace them in `index.html` before publishing.

| Placeholder | Value now | Where it appears |
| --- | --- | --- |
| GitHub URL | `https://github.com/anticlus/anticlus` | "Read the quickstart" button, the benchmark link, the footer |
| Contact email | `hello@anticlus.ai` | "Book a call" button (`mailto:`), the footer |

## Notes

- Light and dark themes follow the visitor's system setting (`prefers-color-scheme`).
- The run excerpt in the terminal block is fixed text. Keep it in step with the product if the output changes.
- No analytics, no cookies, no fonts loaded from elsewhere.
