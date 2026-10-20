# app#41 · Add new product in the top bar — emulated iPhone evidence

**43/43 checks passed** · app `c88283f` (production build `gJ5vR35VH3A4_ldgheP2b`, `next build --webpack`) · 2026-10-20T02:41:49.852Z

- Browser: Chromium 141.0.7390.37 (Playwright `devices["iPhone 13"]`: 390×664 CSS px, DPR 3, touch, iOS Safari user agent), and the same descriptor at 375×548, 360×640 and 320×480. **Desktop emulation, not Safari on an iPhone**: no real iOS keyboard, toolbar or safe area.
- Scrolling: a finger dragged over `main` (CDP `Input.dispatchTouchEvent`), repeated until it stops moving.
- Database: PostgreSQL 18.4 with 50 login migrations applied, built by rebuild-db.sh from login 631c28f + seed; app connects as portal_app (RLS). Media store and label reader are local stand-ins. Owner, business and photos are synthetic.

| | Check | Detail |
|---|---|---|
| ✅ H1 | 390 px, inventory list: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 344–378, icon only, mark shown, overflow 0/0 |
| ✅ H2 | 390 px: Preview iD keeps its icon, and its name for screen readers | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 344–378, icon only, mark shown, overflow 0/0 |
| ✅ H3 | The page asks for no full-bleed layout: Safari keeps it inside the safe area | viewport meta "width=device-width, initial-scale=1" |
| ✅ S1 | From the list, Add new product opens the start page; 4 taps and a plain GET make no item | items 0 before, 0 after; GET /inventory/capture 200 |
| ✅ H4 | 390 px, start page: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 344–378, icon only, mark shown, overflow 0/0 |
| ✅ S2 | Start (the existing button) makes one item and opens its camera |  |
| ✅ H5 | 390 px, item being catalogued: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 344–378, icon only, mark shown, overflow 0/0 |
| ✅ H6 | On an unsaved item, Add new product is the jump to the note on the same page | href #finish-this-item |
| ✅ P1 | 390 px, long item page at the top: bar at the top, main below it | bar top 0px, main from 56px scrolled 0/1834px, frame scrolled 0px, page scrolled 0px |
| ✅ P2 | Swiped to the bottom: only main scrolled; the bar is still at the top | bar top 0px, main from 56px scrolled 1834/1834px, frame scrolled 0px, page scrolled 0px |
| ✅ U1 | Unsaved item, Add new product from the top of the page: same page, scrolled to the note above Save and add another | /inventory/capture/a6eff174-a8ba-4133-aeb9-1a219921be46#finish-this-item; note shown true, in view true; Save and add another in view true; Discard in view true |
| ✅ U2 | The note has focus (read out by a screen reader); the bar stays on screen, above it | focused true, bar on screen true, note below the bar true |
| ✅ U3 | Nothing lost or started: typed name, 3 photos and the open item as they were; no new item | name "Synthetic cacao powder (test)", photos 3, items 1 (was 1) |
| ✅ U4 | The note says to finish it with Save and add another, or discard it | Finish this item before adding a new product. Save and add another saves it and opens the next one. To start over instead, discard this item below. |
| ✅ P3 | After the jump the bar is still at the top: only main moved | bar top 0px, main from 56px scrolled 1964/1964px, frame scrolled 0px, page scrolled 0px |
| ✅ U5 | Tapped twice more: still the same item and form, still no new item |  |
| ✅ F1 | Notes (near the end) focused from the top: scrolled into view in main, below the bar | {"top":339,"bottom":405,"barBottom":56,"mainBottom":664,"active":"notes"} |
| ✅ N1 | Save and add another still saves, and opens the next item saying what was saved | item 1 confirmed; next item open |
| ✅ N2 | The next item arrives with the note hidden |  |
| ✅ U6 | On the next item (still empty) Add new product shows the note too, and starts nothing |  |
| ✅ U7 | Discard this item discards it and returns to the list |  |
| ✅ H7 | 390 px, list with an item: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 344–378, icon only, mark shown, overflow 0/0 |
| ✅ H8 | A saved item's page: Add new product goes to the start page | href /inventory/capture |
| ✅ H9 | 390 px, container page: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 344–378, icon only, mark shown, overflow 0/0 |
| ✅ P4 | 390 px, container page at the top: bar at the top | bar top 0px, main from 56px scrolled 0/1271px, frame scrolled 0px, page scrolled 0px |
| ✅ P5 | Swiped to the bottom of the container page: the bar is still at the top | bar top 0px, main from 56px scrolled 1271/1271px, frame scrolled 0px, page scrolled 0px |
| ✅ M1 | From the bottom of the page the menu opens, with Inventory and iD | 10XiD, Home, Orders, Quotes, Jobs, Inventory, Products, Customers, Growth, Discounts, Content, Markets, Finance, Analytics, Channels, iD, Add channel, Team, Settings |
| ✅ S3 | From the bottom of a container page, Add new product opens the start page; no item made | items 2 → 2 |
| ✅ W375a | 375 px, inventory list: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 329–363, icon only, mark shown, overflow 0/0 |
| ✅ W375b | 375 px: Preview iD as its icon | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 329–363, icon only, mark shown, overflow 0/0 |
| ✅ W375c | 375 px, container page: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 329–363, icon only, mark shown, overflow 0/0 |
| ✅ W360a | 360 px, inventory list: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 314–348, icon only, mark shown, overflow 0/0 |
| ✅ W360b | 360 px: Preview iD as its icon | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 314–348, icon only, mark shown, overflow 0/0 |
| ✅ W360c | 360 px, container page: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD 314–348, icon only, mark shown, overflow 0/0 |
| ✅ W320a | 320 px, inventory list: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD not in the bar, mark shown, overflow 0/0 |
| ✅ W320b | 320 px: Preview iD leaves the bar, and iD is in the menu | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD not in the bar, mark shown, overflow 0/0 |
| ✅ W320c | 320 px, container page: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD not in the bar, mark shown, overflow 0/0 |
| ✅ W320d | 320 px, container page swiped to the bottom: the bar is still at the top | bar top 0px, main from 56px scrolled 1524/1524px, frame scrolled 0px, page scrolled 0px |
| ✅ W320e | 320 px, item being catalogued: Add new product immediately right of Inventory, one line, nothing cut off or off the screen | title 92–161, Add new product 169–296.5 (8px after the title), Preview iD not in the bar, mark shown, overflow 0/0 |
| ✅ W320f | 320 px, unsaved item: Add new product stays, the note is in view with Save and add another, the name is kept | note in view true, Save and add another in view true, bar on screen true, name "Synthetic matcha (test)" |
| ✅ R1 | The start page lists the item left unsaved at 320 px, to carry on with | 1 listed |
| ✅ X1 | Items in the database: only the 3 started with Start or Save and add another (none from Add new product) | 3 items |
| ✅ X2 | No errors in the browser console |  |

## Screens

**390 px · Inventory, nothing catalogued yet: Add new product right of Inventory; Preview iD as its icon**<br><img src="screens/390-list-empty.png" width="390">

**390 px · Add new product from the list: the existing start page (Start, and items started and not saved)**<br><img src="screens/390-start-page.png" width="390">

**390 px · An item being catalogued, top: three synthetic photos sent, name typed**<br><img src="screens/390-capture-top.png" width="390">

**390 px · Same item, bottom: Save and add another, Save, Discard; the bar is still at the top**<br><img src="screens/390-capture-bottom.png" width="390">

**390 px · Add new product on an unsaved item: the page stays, the note says to finish it or discard it**<br><img src="screens/390-capture-note.png" width="390">

**390 px · After Save and add another: the next item, “Saved: … Now the next one.”**<br><img src="screens/390-next-item.png" width="390">

**390 px · Inventory with the saved item**<br><img src="screens/390-list.png" width="390">

**390 px · A container's page, top**<br><img src="screens/390-container-top.png" width="390">

**390 px · Same page, bottom (History); the bar is still at the top**<br><img src="screens/390-container-bottom.png" width="390">

**390 px · The menu, opened from the bottom of the container page**<br><img src="screens/390-menu.png" width="390">

**375 px · Inventory**<br><img src="screens/375-list.png" width="375">

**375 px · A container's page, top**<br><img src="screens/375-container-top.png" width="375">

**360 px · Inventory**<br><img src="screens/360-list.png" width="360">

**360 px · A container's page, top**<br><img src="screens/360-container-top.png" width="360">

**320 px · Inventory**<br><img src="screens/320-list.png" width="320">

**320 px · A container's page, top**<br><img src="screens/320-container-top.png" width="320">

**320 px · Same page, bottom**<br><img src="screens/320-container-bottom.png" width="320">

**320 px · Add new product on an unsaved item**<br><img src="screens/320-capture-note.png" width="320">

**390 px · The start page lists the item left unsaved, to carry on with**<br><img src="screens/390-start-page-resume.png" width="390">
