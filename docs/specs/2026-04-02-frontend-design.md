# iCourse Subscriber Frontend Design Spec

> Status: Draft
> Date: 2026-04-02

## 1. Overview

A browser-based, mobile-first frontend for viewing and editing course summaries stored in a GitHub repository's encrypted SQLite database. Designed to work out of the box after forking, with no server infrastructure required.

**Core constraints:**
- No dedicated server resources; hosting via GitHub Pages only
- Data must remain encrypted at rest; decryption happens client-side
- Fork-and-use: any user who forks the repo and enables GitHub Pages gets a working frontend

## 2. Architecture

### 2.1 Hosting & Deployment

Static files live in `frontend/` on the `main` branch. A GitHub Actions workflow (`deploy-frontend.yml`) copies them to the `gh-pages` branch on every push that touches `frontend/`.

```
main branch:     frontend/index.html, frontend/js/*, frontend/css/*
                        │  (push triggers deploy-frontend.yml)
                        ▼
gh-pages branch: index.html, js/*, css/*
                        │
                        ▼
GitHub Pages:    https://{owner}.github.io/{repo}/
```

### 2.2 Tech Stack (zero build step)

| Layer | Choice | Size | Rationale |
|-------|--------|------|-----------|
| Reactive UI | Alpine.js (CDN) | 15 KB | Declarative, no build, sufficient for SPA |
| Styling | Tailwind CSS (CDN) | - | Mobile-first utilities, no compilation |
| Markdown | marked.js (CDN) | 40 KB | Fast, lightweight |
| LaTeX | KaTeX auto-render (CDN) | ~200 KB | Client-side rendering, no external image requests, proper math fonts; far superior to CodeCogs images |
| HTML sanitize | DOMPurify (CDN) | 20 KB | Prevent XSS from user-edited Markdown |
| SQLite | sql.js (CDN WASM) | ~1.4 MB | Proven in-browser SQLite |
| Crypto | Web Crypto API (built-in) | 0 | PBKDF2 + AES-256-CBC, openssl-compatible |

No npm, no Node, no build pipeline. All dependencies loaded from CDN. A user who forks this repo gets a working frontend by enabling GitHub Pages.

### 2.3 File Structure

```
frontend/
  index.html              ← Entry point, shell layout, Alpine app root
  css/
    app.css               ← Custom styles (minimal, Tailwind handles most)
  js/
    app.js                ← Alpine.js app definition, routing, global state
    crypto.js             ← OpenSSL-compatible PBKDF2 + AES-256-CBC encrypt/decrypt
    github.js             ← GitHub API client (fetch DB, push DB, get SHA)
    db.js                 ← sql.js wrapper (init, query, export bytes)
    render.js             ← Markdown + KaTeX rendering pipeline
    views/
      setup.js            ← First-time configuration wizard
      courses.js          ← Course list view (home)
      lectures.js         ← Lecture list for a single course
      detail.js           ← Single lecture summary reader + editor
      search.js           ← Global full-text search
      settings.js         ← Credential management + advanced options
```

## 3. Data Model

### 3.1 Database Schema

Exact replica of the Python backend's schema (from `src/database.py`):

```sql
CREATE TABLE courses (
    course_id TEXT PRIMARY KEY,
    title     TEXT,
    teacher   TEXT
);

CREATE TABLE lectures (
    sub_id        TEXT PRIMARY KEY,
    course_id     TEXT NOT NULL REFERENCES courses(course_id),
    sub_title     TEXT,
    date          TEXT,            -- legacy field, not displayed
    transcript    TEXT,
    summary       TEXT,
    processed_at  TEXT,            -- ISO timestamp
    emailed_at    TEXT,            -- ISO timestamp
    error_msg     TEXT,
    error_count   INTEGER DEFAULT 0,
    error_stage   TEXT,            -- "transcribe" | "summarize"
    summary_model TEXT             -- e.g. "gemini/gemini-2.5-flash"
);
```

### 3.2 Lecture State Machine

A lecture's display status is derived from its fields:

| State | Condition | Display |
|-------|-----------|---------|
| Ready | `summary IS NOT NULL AND processed_at IS NOT NULL` | Normal card, readable |
| Processing | `transcript IS NOT NULL AND summary IS NULL AND error_stage IS NULL` | Grey, "Summarizing..." |
| Waiting | `transcript IS NULL AND error_stage IS NULL` | Grey, "Waiting for recording" |
| Failed | `error_stage IS NOT NULL` | Red badge, show `error_stage` |

Only "Ready" lectures have a clickable detail view. Others show a brief status line.

### 3.3 GitHub API Endpoints Used

| Operation | Method | Endpoint | Auth |
|-----------|--------|----------|------|
| Fetch encrypted DB | GET | `/repos/{owner}/{repo}/contents/data/icourse.db.enc?ref=data` | PAT |
| Get file SHA | GET | (same, extract `sha` from response) | PAT |
| Push encrypted DB | PUT | `/repos/{owner}/{repo}/contents/data/icourse.db.enc` | PAT |
| Check repo exists | GET | `/repos/{owner}/{repo}` | PAT |

The PUT request requires the current file SHA to prevent silent overwrites (409 Conflict if stale).

## 4. Encryption

### 4.1 OpenSSL Compatibility

The workflow encrypts with:
```bash
openssl enc -aes-256-cbc -salt -pbkdf2 -in db -out db.enc -pass env:DB_KEY
```

File format:
```
Bytes 0-7:    "Salted__" (magic header)
Bytes 8-15:   8-byte random salt
Bytes 16+:    AES-256-CBC ciphertext (PKCS7 padded)
```

Key derivation:
```
password  = STUID + UISPSW + DASHSCOPE_API_KEY + SMTP_PASSWORD  (concatenated strings)
(key, iv) = PBKDF2-HMAC-SHA256(password, salt, iterations, dkLen=48)
key       = first 32 bytes
iv        = last 16 bytes
```

### 4.2 Iteration Count

Default PBKDF2 iterations depend on the OpenSSL version running in GitHub Actions:

| Runner | OpenSSL | Default iterations |
|--------|---------|--------------------|
| ubuntu-22.04 | 3.0.x | 10,000 |
| ubuntu-24.04 | 3.2+ | 600,000 |

**Strategy:** Default to 10,000. Settings page exposes an "Advanced: PBKDF2 iterations" field. On decryption failure, show a message: "Decryption failed. If your GitHub Actions runner was recently upgraded, try changing the iteration count to 600000 in Settings."

### 4.3 Web Crypto Implementation

```javascript
async function deriveKeyAndIV(password, salt, iterations = 10000) {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
        baseKey, 48 * 8  // 48 bytes = 32 (key) + 16 (iv)
    );
    return {
        key: await crypto.subtle.importKey(
            "raw", bits.slice(0, 32), { name: "AES-CBC" }, false,
            ["encrypt", "decrypt"]
        ),
        iv: new Uint8Array(bits.slice(32, 48))
    };
}
```

Decrypt: strip "Salted__" header, extract salt, derive key+iv, `crypto.subtle.decrypt`.
Encrypt: generate random 8-byte salt, derive key+iv, `crypto.subtle.encrypt`, prepend "Salted__" + salt.

## 5. User Interface

### 5.1 Navigation Structure

Mobile-first bottom tab bar with 3 tabs:

```
┌──────────────────────────────┐
│  Header: "iCourse" + sync ↻  │
├──────────────────────────────┤
│                              │
│     (current view content)   │
│                              │
├──────────────────────────────┤
│  [📚 Courses] [🔍 Search] [⚙️] │
└──────────────────────────────┘
```

On desktop (>768px): tabs become a top navigation bar; content area gets `max-width: 800px` centered layout.

### 5.2 Views

#### 5.2.1 Setup Wizard (first visit only)

Shown when `localStorage` has no saved credentials. Explains what each field is and why it's needed.

**Fields:**
1. GitHub PAT — with link to "Create Fine-grained PAT" page, pre-filled permission note: "Only needs Contents: Read and Write on this repository"
2. STUID — Student ID
3. UISPSW — UIS password
4. DASHSCOPE_API_KEY — LLM API key
5. SMTP_PASSWORD — QQ SMTP authorization code

**Validation:** After entry, immediately attempt to fetch + decrypt the DB. Show success/failure inline before saving. This catches wrong credentials early.

**Storage:** All 5 values go to `localStorage`. Keys prefixed with `ics_` to avoid collisions.

#### 5.2.2 Courses View (home tab)

Query:
```sql
SELECT c.course_id, c.title, c.teacher,
       COUNT(CASE WHEN l.summary IS NOT NULL THEN 1 END) AS summary_count,
       COUNT(l.sub_id) AS total_count,
       MAX(l.processed_at) AS last_updated
FROM courses c
LEFT JOIN lectures l ON c.course_id = l.course_id
GROUP BY c.course_id
ORDER BY last_updated DESC NULLS LAST
```

**Layout:** Card list. Each card shows:
- Course title (bold, truncated if needed)
- Teacher name (secondary text)
- Badge: "3/8 summaries" (summary_count / total_count)
- Last updated relative time

Tap a card → navigate to Lectures view for that course.

**Empty state:** "No courses yet. Make sure the workflow has run at least once."

#### 5.2.3 Lectures View

Query:
```sql
SELECT sub_id, sub_title, summary, processed_at, error_stage, error_msg, summary_model
FROM lectures
WHERE course_id = ?
ORDER BY sub_id ASC
```

**Layout:** List of lecture rows. Each row shows:
- Lecture title (`sub_title`)
- Status indicator (Ready / Processing / Waiting / Failed — see state machine in 3.2)
- For "Ready" lectures: first ~80 chars of summary as preview snippet (plain text, strip Markdown)

Tap a "Ready" row → navigate to Detail view.

**Header:** Back arrow + course title + teacher.

#### 5.2.4 Detail View (read + edit)

Primary reading view. Full Markdown rendering with KaTeX.

**Rendering pipeline:**
```
summary (raw text)
  → marked.js parse to HTML
  → DOMPurify sanitize
  → inject into DOM
  → KaTeX auto-render scans for $, $$, \(...\), \[...\]
```

**Read mode (default):**
- Scrollable rendered Markdown
- Top bar: back arrow, lecture title
- Floating "Edit" button (bottom-right FAB on mobile, toolbar button on desktop)
- Metadata footer: "Generated by gemini/gemini-2.5-flash"

**Edit mode:**
- Full-screen `<textarea>` with the raw Markdown
- Top bar: "Cancel" (left), "Preview" (center toggle), "Save" (right)
- Preview toggle: switch between textarea and rendered preview
- Save flow:
  1. Update `summary` in sql.js
  2. Set `summary_model` to `"manual-edit"`
  3. Re-encrypt entire DB
  4. Fetch latest SHA from GitHub API
  5. PUT to GitHub API
  6. Show success toast or error message
  7. On SHA conflict (409): "Database was updated by another source. Refresh and try again."

#### 5.2.5 Search View

**Input:** Search bar at top, searches on every keystroke (debounced 300ms).

**Query:**
```sql
SELECT l.sub_id, l.sub_title, l.summary, c.title AS course_title
FROM lectures l
JOIN courses c ON l.course_id = c.course_id
WHERE l.summary LIKE '%' || ? || '%'
   OR l.sub_title LIKE '%' || ? || '%'
ORDER BY l.processed_at DESC
LIMIT 50
```

**Results:** List of matches showing course title, lecture title, and a context snippet around the match (highlight matched text with `<mark>`).

Tap a result → navigate to Detail view.

#### 5.2.6 Settings View

**Credentials section:**
- Show current values masked (••••••••) with "Show" toggle per field
- "Edit" button per field, or "Edit all" button
- "Test connection" button: re-fetch + decrypt to verify

**Advanced section:**
- PBKDF2 iteration count (default 10000)
- Repository owner/name (auto-detected from URL, editable for custom domains / local dev)
- Data branch name (default "data")

**Danger zone:**
- "Clear all credentials" button with confirmation dialog

## 6. Data Sync

### 6.1 Read Flow

```
App opens
  → Check localStorage for credentials
  → If missing → Setup Wizard
  → If present → Show loading spinner
  → GET /repos/{owner}/{repo}/contents/data/icourse.db.enc?ref=data
  → If 404 → "No database yet" empty state
  → If 200 → Base64 decode response.content
  → Strip "Salted__" + extract salt
  → PBKDF2 derive key+iv → AES-CBC decrypt
  → If decrypt fails → "Wrong credentials or iteration count" error
  → sql.js load DB bytes
  → Show Courses view
```

### 6.2 Write Flow

```
User edits summary and taps Save
  → sql.js: UPDATE lectures SET summary=?, summary_model='manual-edit' WHERE sub_id=?
  → sql.js: export DB as Uint8Array
  → Generate random 8-byte salt
  → PBKDF2 derive key+iv → AES-CBC encrypt
  → Prepend "Salted__" + salt → encrypted bytes
  → Base64 encode
  → GET current SHA: /repos/{owner}/{repo}/contents/data/icourse.db.enc?ref=data
  → PUT /repos/{owner}/{repo}/contents/data/icourse.db.enc
      body: { message: "Update summary via web editor", content: base64, sha: current_sha, branch: "data" }
  → If 200 → success toast, update cached SHA
  → If 409 → "Conflict: DB was updated elsewhere. Please refresh."
  → If 401/403 → "Token expired or insufficient permissions."
```

### 6.3 Refresh Strategy

- **On app focus (visibilitychange event):** Compare remote SHA with cached SHA. If different, prompt "Database updated, refresh?"  — do NOT auto-replace if user has unsaved edits.
- **Manual refresh:** Sync button (↻) in header. Always re-fetches and re-decrypts.
- **After save:** Update cached SHA from PUT response. No re-fetch needed.

## 7. Deployment Workflow

```yaml
# .github/workflows/deploy-frontend.yml
name: Deploy Frontend

on:
  push:
    branches: [main]
    paths: ['frontend/**']

permissions:
  contents: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./frontend
```

### 7.1 Fork User Setup (README section)

1. Fork the repository
2. In repo Settings → Pages → Source: "Deploy from a branch" → `gh-pages` / `/ (root)`
3. Push any commit (or manually trigger the "Deploy Frontend" workflow)
4. Visit `https://{your-username}.github.io/{repo-name}/`
5. Follow the setup wizard to enter your credentials

## 8. Security Considerations

1. **PAT scope:** Fine-grained PAT should be scoped to only the forked repository with "Contents: Read and Write" permission. The setup wizard should include clear instructions with a direct link to GitHub's PAT creation page with pre-selected permissions.

2. **localStorage:** Credentials in `localStorage` are accessible to any JS on the same origin. Since GitHub Pages serves from `{user}.github.io/{repo}/`, the origin is shared with all of that user's GitHub Pages sites. Mitigation: keys are prefixed with `ics_{repo}_` to avoid collision, and we accept this trade-off given the static-hosting-only constraint.

3. **No secrets in the repo:** The frontend code contains zero secrets. All credentials are entered by the user at runtime and stored only in their browser.

4. **DOMPurify:** All Markdown-to-HTML output is sanitized before injection to prevent stored XSS from malicious summary content.

5. **CORS:** GitHub API allows CORS requests with a valid PAT in the Authorization header. No proxy needed.

## 9. Edge Cases

| Scenario | Handling |
|----------|----------|
| `data` branch doesn't exist (fresh fork) | Show "No data yet — run the workflow first" with link to Actions tab |
| Decryption fails | Show error with suggestion to check credentials or PBKDF2 iteration count |
| PAT expired | GitHub API returns 401 → clear toast: "GitHub token expired. Update it in Settings." |
| DB file too large (>100MB) | GitHub API rejects files >100MB. Unlikely (a semester ≈ a few MB), but show error if it happens |
| Concurrent edit conflict (409) | "Database was updated by another source. Refresh and try again." — never silently overwrite |
| Workflow running while user edits | User's save creates a new commit on `data` branch. Next workflow run's merge logic (`merge_db.py`) will merge the changes additively. This is safe because the merge is forward-only. |
| Network error during save | Show "Save failed: network error. Your changes are preserved locally. Try again." — the in-memory sql.js DB is not lost |
| Empty summary (processed but no content) | Show lecture in list as "Empty summary" with a note, still allow editing |
| Very long summary | Detail view scrolls naturally. No truncation. |
| User on `file://` protocol | Web Crypto API requires secure context. Show error: "Please access via https:// (GitHub Pages) or localhost" |

## 10. Repository Auto-Detection

When served on GitHub Pages, the repository owner and name can be extracted from the URL:

```javascript
// https://leafcreeper.github.io/icourse-subscriber/
const [owner, repo] = (() => {
    const host = location.hostname;  // "leafcreeper.github.io"
    const path = location.pathname;  // "/icourse-subscriber/"
    if (host.endsWith('.github.io')) {
        return [host.replace('.github.io', ''), path.split('/')[1]];
    }
    return [null, null];  // Custom domain or local — user must configure in Settings
})();
```

If auto-detection succeeds, these values are pre-filled in Settings but remain editable.

## 11. Implementation Order

1. **crypto.js** — OpenSSL-compatible encrypt/decrypt. This is the hardest part and must be verified against the actual workflow output. Write a test that decrypts a known `.db.enc` file.
2. **github.js** — Fetch/push files via GitHub API.
3. **db.js** — sql.js wrapper: init from bytes, run queries, export bytes.
4. **render.js** — Markdown + KaTeX pipeline.
5. **Setup wizard** — Credential entry + validation (fetch + decrypt test).
6. **Courses view** — Home page with aggregated course cards.
7. **Lectures view** — Lecture list within a course.
8. **Detail view** — Summary reader with KaTeX rendering.
9. **Edit mode** — Textarea + save flow (encrypt + push).
10. **Search view** — Full-text search with highlighted snippets.
11. **Settings view** — Credential management + advanced options.
12. **deploy-frontend.yml** — GitHub Actions workflow for deployment.
13. **README update** — Fork setup instructions.
