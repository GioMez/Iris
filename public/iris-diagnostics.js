/* ===================== Iris · compiler diagnostics ===================== */
(function () {
  function lineRange(text, number) {
    if (!Number.isSafeInteger(number) || number < 1) return null;
    let from = 0;
    for (let line = 1; line < number; line++) {
      const end = text.indexOf("\n", from);
      if (end < 0) return null;
      from = end + 1;
    }
    const end = text.indexOf("\n", from);
    const to = end < 0 ? text.length : end;
    return { from, to: to > from && text[to - 1] === "\r" ? to - 1 : to };
  }

  function renderList(host, diagnostics, { sourceFor, activate, t }) {
    host.replaceChildren();
    diagnostics.forEach((item) => {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = `diagnostic-item ${item.severity}`;
      button.disabled = !sourceFor(item);
      const icon = document.createElement("span");
      icon.className = "diagnostic-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = window.IrisIcons.icon(item.severity === "warning" ? "alert-triangle" : "circle-x");
      const body = document.createElement("span");
      body.className = "diagnostic-body";
      const location = document.createElement("span");
      location.className = "diagnostic-location";
      const line = item.line ?? item.buildLine;
      location.textContent = item.file
        ? `${item.file}${line ? `:${line}${item.column != null ? `:${item.column}` : ""}` : ""}`
        : t("diagnostics.noLocation");
      const severity = document.createElement("span");
      severity.className = "diagnostic-severity";
      severity.textContent = item.severity === "warning" ? t("diagnostics.warning") : t("diagnostics.error");
      const message = document.createElement("span");
      message.className = "diagnostic-message";
      message.textContent = item.message;
      body.appendChild(severity);
      body.appendChild(location);
      body.appendChild(message);
      if (button.disabled && item.file) {
        const hint = document.createElement("span");
        hint.className = "diagnostic-hint";
        hint.textContent = item.loading ? t("diagnostics.loadingSource") : t("diagnostics.sourceUnavailable");
        body.appendChild(hint);
      }
      button.appendChild(icon);
      button.appendChild(body);
      button.addEventListener("click", () => activate(item));
      row.appendChild(button);
      host.appendChild(row);
    });
  }

  // CM owns position mapping. The app reads these same positions for list
  // navigation, so markers and links cannot drift apart after local/remote edits.
  function createGutter(S, V) {
    const effect = S.StateEffect.define();
    const field = S.StateField.define({
      create: () => [],
      update(items, tr) {
        for (const entry of tr.effects) if (entry.is(effect)) {
          return entry.value.filter((item) => Number.isSafeInteger(item.line) && item.line > 0 && item.line <= tr.newDoc.lines)
            .map((item) => ({ item, from: tr.newDoc.line(item.line).from }));
        }
        if (!tr.docChanged) return items;
        return items.flatMap(({ item, from }) => {
          const pos = tr.changes.mapPos(from, 1, S.MapMode.TrackAfter);
          return pos == null ? [] : [{ item, from: tr.newDoc.lineAt(pos).from }];
        });
      },
    });
    const read = (state) => state.field(field).map(({ item, from }) => ({ ...item, line: state.doc.lineAt(from).number }));
    class DiagnosticMarker extends V.GutterMarker {
      constructor(items) {
        super();
        this.severity = items.some((item) => item.severity === "error") ? "error" : "warning";
        this.message = items.map((item) => item.message).join("\n");
      }
      eq(other) { return this.severity === other.severity && this.message === other.message; }
      toDOM() {
        const marker = document.createElement("span");
        marker.className = `cm-iris-diagnostic-mark ${this.severity}`;
        marker.textContent = this.severity === "error" ? "×" : "!";
        marker.title = this.message;
        marker.setAttribute("role", "img");
        marker.setAttribute("aria-label", this.message);
        return marker;
      }
    }
    const gutter = V.gutter({
      class: "cm-iris-diagnostic-gutter",
      markers(view) {
        const lines = new Map();
        for (const { item, from } of view.state.field(field)) {
          if (!lines.has(from)) lines.set(from, []);
          lines.get(from).push(item);
        }
        return S.RangeSet.of(Array.from(lines, ([from, items]) => new DiagnosticMarker(items).range(from)), true);
      },
    });
    return { extension: [field, gutter], effect, read };
  }

  window.IrisDiagnostics = { lineRange, renderList, createGutter };
})();
