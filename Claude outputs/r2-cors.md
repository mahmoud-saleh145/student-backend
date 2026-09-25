# R2 CORS for lecture video uploads

Lecture videos go **browser → R2 directly**, using the presigned PUT that
`POST /videos/uploads/init` returns. That upload is cross-origin, so the bucket
needs a CORS rule naming the dashboard's origin. Without it the browser's
preflight fails and **no bytes move at all** — the dashboard shows
"The upload could not reach storage. Check the connection, or the bucket's CORS
rule for this site."

This applies **only to the uploads bucket** (`R2_BUCKET_UPLOADS`, the one
holding video sources). The media bucket is read through the Worker and the
library bucket is written server-side through the API — neither needs CORS.

## Why direct, when library documents go through the API

A library document is capped at 200 MB and is proxied through
`/api/upload/library-document`, which needs no CORS. A lecture is capped at
8 GB. Proxying that would hold a socket open on the Next server and the API for
the length of the upload, and one slow uploader would occupy a worker for
minutes. `videos.service.ts` puts it the same way from the other side:

> A 2 GB lecture streamed through Node would pin a worker for minutes and cap
> concurrent uploads at one per process.

So the two paths differ deliberately, and the CORS rule is the price of the
video one.

## The rule

Cloudflare dashboard → R2 → the uploads bucket → **Settings** → **CORS Policy**
→ Edit, or `wrangler r2 bucket cors put <bucket> --file r2-cors.json`.

```json
[
  {
    "AllowedOrigins": ["https://REPLACE-ME.example"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Each field, and why it is exactly this:

- **`AllowedOrigins`** — the dashboard's own origin, scheme and port included,
  no trailing slash. It must match `APP_ORIGIN` in the dashboard's `.env`. Add
  the local origin (`http://localhost:3001`) as a second entry only if you want
  uploads to work from `npm run dev`; there is no reason for `*`, and a
  wildcard here would let any site spend a leaked signature.
- **`AllowedMethods`** — `PUT` only. The browser never reads from this bucket:
  sources are private and students stream the HLS output through the Worker, so
  `GET` would grant something the product does not use.
- **`AllowedHeaders`** — `content-type` only. The presigned URL is signed over
  the Content-Type, so the browser must send exactly the header `init`
  returned, and `upload.ts` sends nothing else on purpose: any extra header is
  outside the signature and R2 refuses the request.
- **`ExposeHeaders`** — `ETag` is not required by the current code (the API
  verifies the object by asking storage for its size, not by trusting a header
  the client reports). It is here because it costs nothing and is what any
  future resumable/multipart upload would need.
- **`MaxAgeSeconds`** — how long a browser may cache the preflight. An hour
  means one OPTIONS per session rather than one per upload.

## This does not make the bucket public

A CORS rule says which origins a *browser* may send a request from. It grants
no access on its own: every request still needs the presigned signature, which
is issued only to a signed-in staff account, is scoped to one object key, and
expires in six hours. Leave R2 public access **off** and do not attach an
`r2.dev` domain to this bucket.

## Checking it worked

After saving the rule, in the dashboard: a course → **Content** → a lecture →
**Add video**. A file that reaches "Queued for processing" has been through the
preflight and the PUT.

If it fails at the preflight instead, the browser console names the reason and
it is almost always one of:

- the origin in the rule does not match the dashboard's exactly (`http` vs
  `https`, a port, a trailing slash),
- the rule is on the wrong bucket — it belongs on the **uploads** bucket, not
  the media one,
- the rule was saved less than a minute ago and the old preflight is still
  cached; a hard reload clears it.

A 403 on the PUT itself, rather than a preflight failure, is a different
problem: the signature expired (six hours) or `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` do not grant write on that bucket.
