// Validate generated documents, not page text: legitimate UI may contain the
// word "undefined". A serialized function/undefined is not an HTML snapshot.
export function assertSnapshotHtml(html) {
  if(typeof html!=='string' || !/^\s*(?:<!doctype[^>]*>\s*)?<html(?:\s|>)/i.test(html) ||
      !/<body(?:\s|>)[\s\S]*<\/body\s*>/i.test(html) || !/<\/html\s*>\s*$/i.test(html)) {
    throw new Error('Invalid static preview: expected a complete HTML document; capture again into a fresh output directory');
  }
}
