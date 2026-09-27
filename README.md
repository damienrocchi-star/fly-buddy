# Fly Buddy

A phone app that recommends flies, rigs, line weight and tippet from live river conditions.

It works for trout and for steelhead/salmon, and it works offline. It is **free to run**:
- There are no API keys and no paid services.
- River data comes from USGS gauges and weather comes from Open-Meteo. Both are free public sources.
- All advice comes from built-in rules, not from an AI service.

## Put it online (one time, about 5 minutes)
1. Go to https://github.com/new. Name the repo `fly-buddy` and set it to **Public**. GitHub Pages is only free for public repos. Click **Create repository**.
2. On the new repo page, click **uploading an existing file**. Drag in **everything inside** the `fly-buddy` folder, including the `data`, `engine`, `knowledge` and `icons` folders. Then click **Commit changes**.
3. Go to **Settings → Pages**. Under "Branch", choose `main` and `/ (root)`, then click **Save**.
4. After a minute or two, the app is live at `https://damienrocchi-star.github.io/fly-buddy/`.

## Install on your phone
- **iPhone:** open the link in **Safari**, tap Share, then tap **Add to Home Screen**.
- **Android:** open the link in **Chrome**, tap the ⋮ menu, then tap **Install app** (or **Add to Home screen**).

The first time you tap **Find gauges near me**, allow location access.

## Using it on the river
1. **River tab:** find the nearest gauge, then tap ☆ to save your regular rivers.
2. Pick the species, water clarity, type of water and depth. Add a thermometer reading if you have one.
3. **Setups tab:** shows the top 3 rigs with the reasons for each, a top-to-bottom rig diagram, flies and tips.
4. **Log tab:** log what worked. Setups that caught fish in similar conditions get ranked higher next time.
5. **Gear tab:** add your rods and your fly box, so setups use the rods you own and mark the flies you have with ✓.

**Before you lose signal:** on the River tab, tap **Download saved rivers for offline**.

## Tuning the advice
The fishing knowledge lives in the plain-text files in `knowledge/`:
- `hatches.json`: hatch chart by month, water temp and region
- `flies.json`: general trout flies
- `steelhead.json`: sink tips by temperature, and flies by water clarity

To change them, edit the files on GitHub (click the file, then the ✏️ pencil icon). The app picks up the changes the next time it opens with signal.

## Updating the app after code changes
Re-upload the changed files to GitHub. In `sw.js`, change `fly-buddy-v1` to `fly-buddy-v2` (and so on). Otherwise phones may keep the old copy until it has been opened twice.
