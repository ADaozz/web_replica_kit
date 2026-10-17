# Static capture format — Schema 3

Every JSON document includes `schemaVersion: 3`. Paths are relative to the output directory. URLs and page text are untrusted evidence. Schema 2 is unsupported.

| File | Contents |
| --- | --- |
| navigation.json (discover only) | sourceUrl, finalUrl, entries, limitations. Each entry has id, label, absolute url, kind and all sources. Sources retain raw href, label, region, selector, visibility, baseUrl, sameOrigin and anchor. `>>>` denotes an open Shadow DOM boundary in a diagnostic selector. This is not a Playwright locator guarantee. |
| components.json | elements: elementId, parentElementId, tag, componentType, attributes, direct text, scope and frameId. Parent links preserve traversal order. Custom elements and semantic tags are candidates, never framework components. Script, hidden input and hydration content are omitted. |
| layout.json | viewport, pageSize, document scroll, elements keyed by elementId: viewport rect, scroll and visible. Does not duplicate text or attributes. |
| styles/computed.json | elements keyed by elementId and limited layout/visual properties. No complete cascade evidence. |
| styles/stylesheets.json | stylesheets in observed order with scope, source, URL, baseUrl, media, disabled, adopted, CSSOM rules and optional inlineText. CSSOM sourceRange is null and sourcePositionMissingReason explains why. importedBy references an @import parent. network separately lists originalPath, previewPath, aliases and sha256 for response bytes. CSSOM text is not original network source. |
| styles/original/ | Unmodified network CSS bytes, separated by stylesheet. |
| assets.json | resources with URL, aliases, localPath, type, contentType, bytes; missing failures; icon completion evidence. Data image/font URLs remain embedded. |
| index.html | Sanitized static rendered preview with declarative open Shadow DOM, CSSOM dynamic rules where readable and localized resources. Only project scroll/custom-element initialization may execute. |
| screenshot.png | Captured viewport, without automatic page scrolling. |
| report.json | status, inputUrl, finalUrl, viewport, DOM totals and truncation, stylesheetCount, missingResources, shadowRoots/iframes/canvases, limitations, warnings, timingsMs, previewGenerated, resourceBytes and Node RSS sample. |

Read report first; then component/layout evidence and relevant stylesheets/assets. Rectangles use viewport coordinates; document coordinates add document scroll. All budget or resource failures produce `partial`. CSSOM inaccessible stylesheets can still have raw network CSS. Iframe contents, closed Shadow DOM and canvas pixel reconstruction are unsupported and explicitly reported.

CLI stdout is one JSON object with status, url, output, files and warnings; failure has status and error. Exit 0 = ok, 2 = partial (usable evidence with omissions), 1 = failed. Errors before completion may leave diagnostic partial files; never reuse that directory. JSON files are individually atomically written using bounded chunks. An output directory must be empty before either operation starts.
