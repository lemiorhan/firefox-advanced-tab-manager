# Advanced Tab Manager

A Firefox extension that automatically organizes your tabs into color-coded
tab groups based on URL patterns. Write a rule once and every matching tab
lands in its group, whether you open it, navigate to it or already had it open.

## Features

- 🎯 **Automatic grouping** - Tabs join the group of the first rule whose
  pattern matches their URL, and leave it when they navigate away
- 🔍 **Wildcard patterns** - Use `*` to match any part of a URL and `|` to give
  one rule several alternatives
- ↕️ **Rule priority** - Rules are checked from top to bottom; reorder them with
  the arrow buttons on the settings page
- 🔢 **Tab counts** - Each group's title shows how many tabs it holds, e.g.
  `Work(4)`
- 📦 **"etc" group** - Tabs that match no rule can be collected in a grey
  `etc` group, or left ungrouped
- 🔤 **Group order** - Managed groups are kept in alphabetical or creation
  order in the tab bar
- 🎨 **Group colors** - Use the color you assigned to each rule, or random
  colors where neighboring groups are kept from sharing a color
- 📂 **Auto expand** - A collapsed group opens when the active tab joins it
- 🖌️ **Selected tab theme** - Optionally tint the selected tab with its group's
  color, outlined in its container's color
- 💾 **Backup & restore** - Export rules and settings to JSON, and import them
  back by replacing or merging

## Installation

### From source

1. Clone or download this repository
2. Open Firefox and navigate to `about:debugging`
3. Click "This Firefox" → "Load Temporary Add-on"
4. Select the `manifest.json` file in the `firefox/` folder

## Usage

### Adding a rule

1. Click the extension icon in your toolbar, or open the settings page with
   the ⚙ link in the popup
2. Fill in the form:
   - **Group name**: A friendly name for the group (e.g., "Work", "Social Media")
   - **Pattern**: URL pattern with wildcards (e.g., `github.com`, `*youtube.com/watch*`)
   - **Color**: Choose a color for the tab group
3. Click "Add Rule"

Existing tabs are regrouped as soon as a rule is added, edited, reordered or
deleted.

### Pattern syntax

A pattern is matched, case-insensitively, against the tab's host and against
its host, path and query string. `http://` and `https://` are ignored on both
sides, and both the URL with and without a leading `www.` are tried. A pattern
is not anchored, so it matches anywhere in the text it is tested against.

- `github.com` - Matches `github.com` and every subdomain, such as
  `gist.github.com`. It also matches `notgithub.com` and any URL that has
  `github.com` in its path or query.
- `*.github.com/*` - Matches subdomains such as `gist.github.com` and
  `www.github.com`, but not `github.com` itself
- `*reddit.com*` - Matches Reddit and any subdomain
- `*youtube.com/watch*` - Matches YouTube video pages
- `*github.com*|*gitlab.com*` - Matches either site

### Rule priority

When several rules match a tab, the one highest in the list wins. Put specific
rules, like `github.com/mozilla`, above broad ones, like `github.com`. The
settings page lists rules in priority order with ↑ and ↓ buttons; the popup
lists them in the chosen group order.

### Settings

- **Group unmatched tabs in "etc"** - On by default. When off, tabs that match
  no rule are taken out of their group.
- **Group order** - Alphabetical (default) or creation order. In creation order
  `etc` comes last.
- **Group colors** - Assigned colors, or Random. Switching to Random recolors
  the open groups. New groups get a color not yet used in their window while
  one is left. Neighboring groups are recolored apart whenever tabs are sorted;
  a group you drag next to one of its own color keeps the clash until then.
- **Color the selected tab by its group** - Off by default. While a grouped tab
  is selected this replaces your Firefox theme for that window.

### Backup & restore

Export writes your rules and settings to a JSON file. Import either replaces
all rules or merges them: a rule with the same group name updates the existing
one and keeps its position. Backups exported by Auto Group Tabs, the extension
this one grew out of, can be imported too.

## Privacy

This extension:

- ✅ Works entirely locally - no data is sent anywhere
- ✅ Reads tab URLs to match patterns, and container colors and your theme for
  the selected tab color
- ✅ Stores rules in your browser's local storage
- ✅ No tracking, analytics, or external requests

## Compatibility

Firefox 140 or newer.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Advanced Tab Manager started as a fork of
[Auto Group Tabs](https://github.com/ErikVib/auto-group-tabs) by ErikVib.

## License

MIT License - See [LICENSE](LICENSE) for details.
