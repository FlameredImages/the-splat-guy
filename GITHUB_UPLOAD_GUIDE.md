# How to Put The Splat Guy on GitHub

## What You Need First

- A GitHub account — sign up free at [github.com](https://github.com)
- Git installed on your PC — download from [git-scm.com](https://git-scm.com/download/win) (just click through the installer, defaults are fine)

---

## Step 1 — Create a New Repository on GitHub

1. Go to [github.com](https://github.com) and log in
2. Click the **+** button (top right) → **New repository**
3. Fill in:
   - **Repository name:** `the-splat-guy` (or whatever you want)
   - **Description:** `WebUI wrapper for Apple SHARP — single image to 3D Gaussian Splat`
   - **Public** or **Private** — your choice
   - ❌ Do NOT tick "Add a README file" — you already have one
4. Click **Create repository**
5. GitHub will show you an empty repo page — leave this open, you'll need the URL

---

## Step 2 — Prepare Your Local Folder

Your folder should look like this before uploading:

```
APPLE_The Splat Guy_App\
    app.py
    launch.bat
    install.bat
    README.md           ← add this (from the files provided)
    LICENSE             ← add this (from the files provided)
    .gitignore          ← add this (from the files provided)
    templates\
        index.html
    static\
        splat.js
```

**Important — do NOT include:**
- `uploads\` folder (contains your personal images)
- `outputs\` folder (contains generated files, can be large)
- These are already excluded by `.gitignore`

---

## Step 3 — Open Git Bash or Command Prompt

Right-click inside your `APPLE_The Splat Guy_App` folder → **Open in Terminal** (or **Git Bash Here**)

---

## Step 4 — Initialise Git and Make Your First Commit

Type these commands one at a time, pressing Enter after each:

```bash
git init
```
*(Initialises git tracking in this folder)*

```bash
git add .
```
*(Stages all your files — the .gitignore will automatically exclude uploads/ and outputs/)*

```bash
git commit -m "Initial release — The Splat Guy v1.0"
```
*(Saves a snapshot with a message)*

---

## Step 5 — Connect to GitHub and Push

Copy the URL from your new GitHub repo page (looks like `https://github.com/YOUR_USERNAME/the-splat-guy.git`), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/the-splat-guy.git
```

```bash
git branch -M main
```

```bash
git push -u origin main
```

GitHub will ask for your username and password the first time.  
**Note:** GitHub no longer accepts your account password here — you need a **Personal Access Token** instead:

1. Go to GitHub → Settings → Developer Settings → Personal Access Tokens → Tokens (classic)
2. Click **Generate new token**
3. Give it a name, set expiry, tick **repo** scope
4. Copy the token and use it as your password when git asks

---

## Step 6 — Verify

Refresh your GitHub repo page — you should see all your files, and the README will display automatically below them.

---

## Making Updates Later

When you change files and want to push the updates:

```bash
git add .
git commit -m "Brief description of what changed"
git push
```

That's it.

---

## Adding a Topic Tag on GitHub

On your repo page, click the ⚙ gear icon next to **About** and add topics:
`gaussian-splatting` `3d-reconstruction` `flask` `apple-sharp` `webgl` `python`

This helps people find your project.

---

## Recommended Repo Description (copy-paste into GitHub About)

> WebUI for Apple SHARP — turns a single photo into a 3D Gaussian Splat. Includes batch processing, webcam input, PLY converter for Postshot, and an inline WebGL viewer.
