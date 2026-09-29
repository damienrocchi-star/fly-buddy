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

- `salmon.json`: salmon streamers and egg patterns
- `rating.json`: how the conditions score is weighted
- `rivers.json`: river profiles (see below)

To change them, edit the files on GitHub (click the file, then the ✏️ pencil icon). The app picks up the changes the next time it opens with signal.

## Adding a river profile
A profile tells the app which fish a river holds, when they run, its signature hatches, local notes and where to find fishing reports. The app matches a gauge to a profile by its name (for example, "pere marquette" plus state "MI").

**The easy way:** open the river in the app, go to **About this river**, and tap **Build profile with Claude**.
1. Copy Claude's answer and paste it back into the app. The profile is saved on your phone straight away.
2. To share it with everyone who uses the app, tap **Copy profile to share**.
3. On GitHub, open `knowledge/rivers.json`, click ✏️, and paste the profile inside the `"rivers": [ ... ]` list. Add a comma after the previous entry.
4. Commit.

**Profile fields:**
- `match`: words from the gauge name
- `state`: the state code
- `species`: `trout`, `steelhead` and/or `salmon`
- `runs`: each with a `label`, `months` (1-12) and `peak` months
- `hatches`: names from `hatchLibrary` (`HEX`, `BROWN_DRAKE`, `ISONYCHIA`) or full hatch entries
- `notes`
- `dnr`: words to look for in the Michigan DNR report
- `feeds`: RSS feeds of shop reports
- `reports`: report web pages. The daily job tries to find a feed on each one.

## How fishing reports update
A free GitHub Action (`.github/workflows/fishing-reports.yml`) runs every morning. It:
1. reads the Michigan DNR weekly report and every shop feed listed in `rivers.json`
2. saves the headlines, dates, short previews and links to `data/reports.json`

The app shows them under **About this river**, with a link to each full report on the shop's site.

**How reports influence setups:** while fetching each post, the daily job also saves the fishing keywords it finds in the full text. It keeps only the matched words, e.g. "eggs", "streamers", "chartreuse", "low and clear", "Hex", never the shop's text. Keywords in "no Hex yet" are ignored.

For the river you're on, keywords from shop reports up to 7 days old (and DNR reports up to 10 days old):
- rank matching setups higher
- put matching fly colors first
- add a credited note, e.g. "📰 From Baldwin Bait & Tackle (Sep 28): egg patterns · low, clear water"

They nudge the advice but never override it. The word lists are in `knowledge/report-signals.json`.

**One-time setup, after uploading:**
1. Settings → Actions → General → Workflow permissions → choose **Read and write permissions** → Save.
2. Actions tab → **Fishing reports** → **Run workflow**.

After that it runs on its own.

## Updating the app after code changes
Re-upload the changed files to GitHub. Bump the version in two places: `CACHE` in `sw.js` and `APP_VERSION` in `app.js`. The Gear tab shows the version, so you can confirm your phone has the update.
