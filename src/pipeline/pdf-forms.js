const { PDFName, PDFDict, PDFArray, PDFString, PDFHexString, PDFNull } = require("pdf-lib/dist/pdf-lib.min.js");
const { LUA_DATA_POLICY, fail } = require("./contracts");

const name = value => PDFName.of(value);
const invalid = () => fail("PIPELINE_PDF_INVALID", "Invalid imported form ownership");
const unsupported = () => fail("PIPELINE_PDF_UNSUPPORTED", "PDF form behavior cannot be preserved by composition");

// Rewriting signed bytes invalidates signatures. XFA and authored scripts also
// need document-level behavior beyond independent, renamed AcroForm fields.
function validateFormPreservation(document) {
  let values = 0;
  const seen = new Set(), active = new Set();
  function fieldType(field) {
    const parents = new Set();
    while (field) {
      if (++values > LUA_DATA_POLICY.maxValues) fail("PIPELINE_OUTPUT_LIMIT", "PDF form metadata exceeds its limit");
      if (parents.has(field) || parents.size > 64) invalid();
      parents.add(field);
      const type = field.lookup(name("FT"));
      if (type) return type.decodeText?.();
      field = field.lookupMaybe(name("Parent"), PDFDict);
    }
  }
  function visit(value, depth = 0) {
    if (++values > LUA_DATA_POLICY.maxValues) fail("PIPELINE_OUTPUT_LIMIT", "PDF form metadata exceeds its limit");
    if (depth > 64) invalid();
    value = document.context.lookup(value);
    if (!(value instanceof PDFDict) && !(value instanceof PDFArray)) return;
    if (active.has(value)) invalid();
    if (seen.has(value)) return;
    seen.add(value); active.add(value);
    if (value instanceof PDFArray) for (const child of value.asArray()) visit(child, depth + 1);
    else {
      if (value.lookup(name("S"))?.decodeText?.() === "JavaScript") unsupported();
      if (value.has(name("V")) && value.lookup(name("V")) !== PDFNull && fieldType(value) === "Sig") unsupported();
      for (const key of ["A", "Next", "Kids"]) if (value.has(name(key))) visit(value.get(name(key)), depth + 1);
      const actions = value.lookupMaybe(name("AA"), PDFDict);
      if (actions) for (const [, action] of actions.entries()) visit(action, depth + 1);
    }
    active.delete(value);
  }
  const form = document.catalog.lookupMaybe(name("AcroForm"), PDFDict);
  if (form?.has(name("XFA")) || document.catalog.has(name("Perms"))
    || document.catalog.lookupMaybe(name("Names"), PDFDict)?.has(name("JavaScript"))) unsupported();
  if (form) visit(form.get(name("Fields")));
  visit(document.catalog.get(name("OpenAction")));
  const actions = document.catalog.lookupMaybe(name("AA"), PDFDict);
  if (actions) for (const [, action] of actions.entries()) visit(action);
  for (const page of document.getPages()) visit(page.node.Annots());
}

// One namespace per placement, as requested: independent copies keep their own
// values while widgets belonging to one radio group still share that field.
function createFormPlacement({ document, source, copier, budget, matrix }) {
  let group, form, prefix, aliases;
  const fields = new Map(), terminals = new Set();
  function initialize() {
    if (group) return;
    const original = source.catalog.lookupMaybe(name("AcroForm"), PDFDict);
    if (!original || original.has(name("XFA"))) invalid();
    form = document.catalog.lookupMaybe(name("AcroForm"), PDFDict);
    if (!form) { form = document.context.obj({ Fields: [] }); document.catalog.set(name("AcroForm"), document.context.register(form)); }
    let roots = form.lookupMaybe(name("Fields"), PDFArray);
    if (!roots) { roots = document.context.obj([]); form.set(name("Fields"), roots); }
    const names = new Set(roots.asArray().map((ref, index) => roots.lookup(index, PDFDict).lookup(name("T"))?.decodeText?.()));
    let counter = 1;
    do { prefix = `iris_layer_${counter++}`; } while (names.has(prefix));
    aliases = new Map();
    const dr = original.lookupMaybe(name("DR"), PDFDict);
    if (dr) {
      let resources = form.lookupMaybe(name("DR"), PDFDict);
      if (!resources) { resources = document.context.obj({}); form.set(name("DR"), resources); }
      for (const [kind, value] of dr.entries()) {
        const entries = source.context.lookup(value);
        // ProcSet is an obsolete but valid resource array, not a named-resource
        // dictionary. Appearance regeneration uses the copied font resources.
        if (kind === name("ProcSet") && entries instanceof PDFArray) continue;
        if (!(entries instanceof PDFDict)) invalid();
        let destination = resources.lookupMaybe(kind, PDFDict);
        if (!destination) { destination = document.context.obj({}); resources.set(kind, destination); }
        for (const [key, resource] of entries.entries()) {
          budget(1);
          let alias = `${prefix}_${key.decodeText()}`;
          while (destination.has(name(alias))) alias += "_";
          destination.set(name(alias), copier.copy(resource)); aliases.set(key.toString(), name(alias).toString());
        }
      }
    }
    const dict = document.context.obj({ T: PDFHexString.fromText(prefix), Kids: [] }), ref = document.context.register(dict);
    group = { dict, ref, fullName: prefix, originalName: "" };
    for (const key of ["DA", "Q"]) if (original.has(name(key))) dict.set(name(key), key === "DA" ? appearance(original.lookup(name(key))) : copier.copy(original.get(name(key))));
    roots.push(ref);
  }
  function appearance(value) {
    const text = value?.decodeText?.();
    if (typeof text !== "string") invalid();
    const scale = Math.hypot(matrix[2], matrix[3]);
    return PDFString.of(text.replace(/\/[^\s<>\[\](){}\/%]+/g, token => {
      const decoded = name(token.slice(1).replace(/#([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))).toString();
      return aliases.get(decoded) || token;
    }).replace(/(\/[^\s]+)\s+([+-]?(?:\d*\.\d+|\d+))\s+Tf\b/g, (_, font, size) => `${font} ${Number(size) * scale} Tf`));
  }
  function field(original, ancestors = new Set()) {
    budget(1);
    if (!(original instanceof PDFDict) || ancestors.has(original) || ancestors.size >= 64) invalid();
    if (fields.has(original)) return fields.get(original);
    ancestors.add(original);
    const parent = original.lookupMaybe(name("Parent"), PDFDict);
    const owner = parent ? field(parent, ancestors) : group;
    let clone = original.clone();
    if (original.lookup(name("Subtype"))?.decodeText?.() === "Widget") {
      // Split a merged field/widget so repeated placements can own independent
      // fields while keeping each interactive rectangle on its target page.
      clone = source.context.obj({});
      for (const key of ["FT", "T", "TU", "TM", "Ff", "V", "DV", "DA", "Q", "DS", "RV", "Opt", "MaxLen", "TI", "I", "Lock", "SV"]) {
        if (original.has(name(key))) clone.set(name(key), original.get(name(key)));
      }
    }
    for (const key of ["Parent", "Kids", "P", "A", "AA"]) clone.delete(name(key));
    const dict = copier.copy(clone), ref = document.context.register(dict);
    dict.set(name("Parent"), owner.ref); dict.set(name("Kids"), document.context.obj([]));
    if (original.has(name("DA"))) dict.set(name("DA"), appearance(original.lookup(name("DA"))));
    owner.dict.lookup(name("Kids"), PDFArray).push(ref);
    const partial = original.lookup(name("T"))?.decodeText?.() || "";
    const copied = { dict, ref, fullName: owner.fullName + (partial ? `.${partial}` : ""),
      originalName: owner.originalName + (owner.originalName && partial ? "." : "") + partial };
    fields.set(original, copied);
    return copied;
  }
  return {
    mapActions(rewrite) {
      for (const [original, { dict }] of fields) rewrite(original, dict,
        original.lookup(name("Subtype"))?.decodeText?.() === "Widget" ? "field" : undefined);
    },
    targetName(value) {
      const key = value?.decodeText?.(), target = [...fields.values()].find(field => field.originalName === key);
      if (!target) invalid();
      return PDFHexString.fromText(target.fullName);
    },
    attach(original, copy, ref) {
      initialize();
      const combined = original.has(name("T")) || original.has(name("FT"));
      const parent = combined ? original : original.lookupMaybe(name("Parent"), PDFDict);
      if (!parent) invalid();
      const owner = field(parent);
      if (combined) for (const key of ["FT", "T", "TU", "TM", "Ff", "V", "DV", "DA", "Q", "DS", "RV", "Opt", "MaxLen", "TI", "I", "Lock", "SV"]) copy.delete(name(key));
      copy.set(name("Parent"), owner.ref);
      if (!combined && original.has(name("DA"))) copy.set(name("DA"), appearance(original.lookup(name("DA"))));
      // Several widgets may share the same indirect characteristics dictionary.
      // Rotation belongs to this widget, not to the shared resource.
      const mk = copy.lookupMaybe(name("MK"), PDFDict)?.clone() || document.context.obj({});
      copy.set(name("MK"), mk);
      const rotation = mk.lookup(name("R"))?.asNumber?.() || 0;
      mk.set(name("R"), document.context.obj(((rotation + Math.round(Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI)) % 360 + 360) % 360));
      owner.dict.lookup(name("Kids"), PDFArray).push(ref);
      terminals.add(owner);
    },
    scopeActionFields(original, copy) {
      const specified = original.lookupMaybe(name("Fields"), PDFArray), flags = original.lookup(name("Flags"))?.asNumber?.() || 0;
      if (!Number.isSafeInteger(flags) || flags < 0 || flags > 0x7fffffff || !terminals.size) invalid();
      const requested = new Set();
      if (specified) for (const value of specified.asArray()) {
        budget(1);
        const target = source.context.lookup(value), key = target?.decodeText?.() || fields.get(target)?.originalName;
        if (!key) invalid();
        const matches = [...terminals].filter(field => field.originalName === key || field.originalName.startsWith(`${key}.`));
        if (!matches.length) invalid();
        for (const field of matches) requested.add(field);
      }
      const selected = [...terminals].filter(field => !specified || ((flags & 1) ? !requested.has(field) : requested.has(field)));
      if (!selected.length) invalid();
      copy.set(name("Fields"), document.context.obj(selected.map(field => PDFHexString.fromText(field.fullName))));
      copy.set(name("Flags"), document.context.obj(flags & ~1));
    },
  };
}

module.exports = { createFormPlacement, validateFormPreservation };
