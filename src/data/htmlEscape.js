// HTML escape for raw interpolation into print-window HTML strings.
//
// Why this matters: several components build a full HTML document as a
// template string, then call `printWin.document.write(html)`. Any
// string interpolated into that template is parsed as HTML by the new
// window. Item names, staff names, customer names, notes — anything
// editable in our app or fetched from a vendor — can carry markup or
// script tags. Worst case: a staff member who can edit a custom prep
// item names it `<img src=x onerror=fetch('/api/leak?…')>`, prints a
// list, and the print window — which holds a `window.opener` reference
// back to the authenticated portal — executes script with that opener.
//
// React-rendered JSX is NOT vulnerable; React auto-escapes. This helper
// is ONLY for the document.write code path.
//
// Mirrors the OWASP "HTML element content" escape set. Anything that
// goes into an attribute value (e.g. style="…") still needs the same
// treatment plus quote escaping — already handled here for `"` and `'`.

export function escapeHtml(value) {
    if (value == null) return "";
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// Convenience for tagged template usage: `html`${userInput}` would NOT
// auto-escape, so consumers must keep using escapeHtml() explicitly.
// Exported as a no-op for grep-ability of "this is a print HTML
// template" without changing behavior.
export function h(strings, ...values) {
    let out = "";
    for (let i = 0; i < strings.length; i++) {
        out += strings[i];
        if (i < values.length) out += escapeHtml(values[i]);
    }
    return out;
}
