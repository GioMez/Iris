const { PDFName, PDFArray, PDFDict, PDFStream, PDFNull, PDFObjectCopier } = require("pdf-lib/dist/pdf-lib.min.js");
const { LUA_DATA_POLICY, fail } = require("./contracts");
const { createFormPlacement } = require("./pdf-forms");

const name = value => PDFName.of(value);
const invalid = () => fail("PIPELINE_PDF_INVALID", "Invalid layer annotation geometry or reference");
function numbers(array, count) {
  if (!(array instanceof PDFArray) || (count !== undefined && array.size() !== count)) invalid();
  return array.asArray().map((value, index) => {
    const number = array.lookup(index)?.asNumber?.();
    if (!Number.isFinite(number)) invalid();
    return number;
  });
}
function point(matrix, x, y) {
  return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
}
function rectangle(matrix, box) {
  const points = [point(matrix, box[0], box[1]), point(matrix, box[0], box[3]), point(matrix, box[2], box[1]), point(matrix, box[2], box[3])];
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}
function concatenate(first, second) {
  return [first[0] * second[0] + first[2] * second[1], first[1] * second[0] + first[3] * second[1],
    first[0] * second[2] + first[2] * second[3], first[1] * second[2] + first[3] * second[3],
    ...point(first, second[4], second[5])];
}

// Page contents and annotations have separate PDF ownership. Copy interactive
// objects explicitly and repair their page/annotation references per placement;
// copying the source page graph would retain invisible donor pages and fields.
function copyLayerAnnotations(document, placements) {
  let values = 0;
  const underlays = new Map();
  const budget = count => { if ((values += count) > LUA_DATA_POLICY.maxValues) fail("PIPELINE_OUTPUT_LIMIT", "Layer annotations exceed their metadata limit"); };
  function destination(value, current) {
    const { source } = current;
    const seen = new Set();
    function resolve(value, depth = 0) {
      budget(1);
      if (depth > 64) invalid();
      value = source.context.lookup(value);
      if (value instanceof PDFArray) return value;
      if (seen.has(value)) invalid();
      seen.add(value);
      if (value instanceof PDFDict) return resolve(value.get(name("D")), depth + 1);
      const key = value?.decodeText?.();
      if (typeof key !== "string") invalid();
      const legacy = source.catalog.lookupMaybe(name("Dests"), PDFDict);
      if (legacy?.has(name(key))) return resolve(legacy.get(name(key)), depth + 1);
      const tree = source.catalog.lookupMaybe(name("Names"), PDFDict)?.lookupMaybe(name("Dests"), PDFDict);
      const visited = new Set();
      function search(node, level) {
        budget(1);
        if (!(node instanceof PDFDict) || visited.has(node) || level > 64) invalid();
        visited.add(node);
        const names = node.lookupMaybe(name("Names"), PDFArray);
        if (names) {
          if (names.size() % 2) invalid();
          budget(names.size());
          for (let i = 0; i < names.size(); i += 2) if (names.lookup(i)?.decodeText?.() === key) return names.get(i + 1);
        }
        const children = node.lookupMaybe(name("Kids"), PDFArray);
        if (children) for (let i = 0; i < children.size(); i++) {
          const found = search(children.lookup(i), level + 1);
          if (found) return found;
        }
      }
      const found = tree && search(tree, 0);
      if (!found) invalid();
      return resolve(found, depth + 1);
    }
    const raw = resolve(value), page = source.context.lookup(raw.get(0));
    const candidates = placements.filter(item => item.source === source && item.sourcePage.node === page);
    const target = current.sourcePage.node === page ? current : candidates.length === 1 ? candidates[0] : null;
    if (!target) invalid();
    const type = raw.lookup(1)?.decodeText?.(), matrix = target.matrix;
    function scalar(index) {
      const value = raw.lookup(index);
      if (value === PDFNull) return null;
      const number = value?.asNumber?.();
      if (!Number.isFinite(number)) invalid();
      return number;
    }
    function coordinate(a, b, x, y, offset) {
      return (a && x === null) || (b && y === null) ? null : a * x + b * y + offset;
    }
    let mapped;
    if (type === "XYZ" && raw.size() === 5) {
      const x = scalar(2), y = scalar(3);
      mapped = ["XYZ", coordinate(matrix[0], matrix[2], x, y, matrix[4]), coordinate(matrix[1], matrix[3], x, y, matrix[5]), scalar(4)];
    } else if (type === "FitR" && raw.size() === 6) {
      mapped = ["FitR", ...rectangle(matrix, [2, 3, 4, 5].map(index => { const value = scalar(index); if (value === null) invalid(); return value; }))];
    } else if (["Fit", "FitB"].includes(type) && raw.size() === 2) mapped = ["FitR", ...rectangle(matrix, target.crop)];
    else if (["FitH", "FitBH", "FitV", "FitBV"].includes(type) && raw.size() === 3) {
      const horizontal = type.endsWith("H"), swapped = matrix[0] === 0;
      const value = scalar(2), outputHorizontal = horizontal !== swapped;
      const scale = horizontal ? (swapped ? matrix[2] : matrix[3]) : (swapped ? matrix[1] : matrix[0]);
      mapped = [`Fit${type.includes("B") ? "B" : ""}${outputHorizontal ? "H" : "V"}`, value === null ? null : value * scale + matrix[outputHorizontal ? 5 : 4]];
    } else invalid();
    return document.context.obj([target.target.ref, ...mapped]);
  }
  function appearance(value, oldRect, newRect, matrix, crop, depth = 0) {
    budget(1);
    if (depth > 64) invalid();
    const object = document.context.lookup(value);
    if (object instanceof PDFStream) {
      const bbox = numbers(object.dict.lookup(name("BBox")), 4);
      const ownMatrix = object.dict.has(name("Matrix")) ? numbers(object.dict.lookup(name("Matrix")), 6) : [1, 0, 0, 1, 0, 0];
      const box = rectangle(ownMatrix, bbox);
      if (box[0] >= box[2] || box[1] >= box[3]) invalid();
      const sx = (oldRect[2] - oldRect[0]) / (box[2] - box[0]), sy = (oldRect[3] - oldRect[1]) / (box[3] - box[1]);
      const fit = [sx, 0, 0, sy, oldRect[0] - box[0] * sx, oldRect[1] - box[1] * sy];
      const transform = concatenate(matrix, fit);
      const clip = `${crop[0]} ${crop[1]} ${crop[2] - crop[0]} ${crop[3] - crop[1]} re W n`;
      return document.context.register(document.context.flateStream(`q ${clip} ${transform.join(" ")} cm /Original Do Q`, {
        Type: "XObject", Subtype: "Form", BBox: newRect, Resources: { XObject: { Original: value } },
      }));
    }
    if (!(object instanceof PDFDict)) invalid();
    const result = document.context.obj({});
    for (const [key, child] of object.entries()) result.set(key, appearance(child, oldRect, newRect, matrix, crop, depth + 1));
    return result;
  }
  for (const placement of placements) {
    const { source, sourcePage, target, matrix } = placement, annotations = sourcePage.node.Annots();
    if (!annotations) continue;
    budget(annotations.size());
    const copier = PDFObjectCopier.for(source.context, document.context), imported = new Map();
    const form = createFormPlacement({ document, source, copier, budget, matrix });
    for (let index = 0; index < annotations.size(); index++) {
      const original = annotations.lookup(index);
      if (!(original instanceof PDFDict) || imported.has(original)) invalid();
      const clone = original.clone();
      for (const key of ["P", "Popup", "IRT", "Parent", "A", "AA", "Dest"]) clone.delete(name(key));
      const copy = copier.copy(clone), ref = document.context.register(copy);
      imported.set(original, { copy, ref });
    }
    for (const [original, { copy, ref }] of imported) {
      if (original.lookup(name("Subtype"))?.decodeText?.() === "Widget") form.attach(original, copy, ref);
    }
    const actionsSeen = new Set();
    function hideTarget(value, depth = 0) {
      budget(1);
      if (depth > 64) invalid();
      const object = source.context.lookup(value);
      if (object instanceof PDFArray) return document.context.obj(object.asArray().map(child => hideTarget(child, depth + 1)));
      if (object instanceof PDFDict) {
        const annotation = imported.get(object);
        if (!annotation) invalid();
        return annotation.ref;
      }
      return form.targetName(object);
    }
    function action(value, depth = 0) {
      budget(1);
      const object = source.context.lookup(value);
      if (depth > 64 || actionsSeen.has(object)) invalid();
      actionsSeen.add(object);
      let result;
      if (object instanceof PDFArray) result = document.context.obj(object.asArray().map(child => action(child, depth + 1)));
      else {
        if (!(object instanceof PDFDict)) invalid();
        const clone = object.clone(), kind = object.lookup(name("S"))?.decodeText?.(), local = kind === "GoTo";
        const fieldAction = kind === "ResetForm" || kind === "SubmitForm";
        clone.delete(name("Next"));
        if (local) clone.delete(name("D"));
        if (fieldAction) clone.delete(name("Fields"));
        if (kind === "Hide") clone.delete(name("T"));
        result = copier.copy(clone);
        if (local) result.set(name("D"), destination(object.get(name("D")), placement));
        if (fieldAction) form.scopeActionFields(object, result);
        if (kind === "Hide") result.set(name("T"), hideTarget(object.get(name("T"))));
        if (object.has(name("Next"))) result.set(name("Next"), action(object.get(name("Next")), depth + 1));
      }
      actionsSeen.delete(object); return result;
    }
    function rewriteActions(original, copy, part) {
      if (part !== "field" && original.has(name("A"))) copy.set(name("A"), action(original.get(name("A"))));
      if (original.has(name("AA"))) {
        const aa = original.lookup(name("AA"), PDFDict), mapped = document.context.obj({});
        for (const [key, value] of aa.entries()) {
          const fieldEvent = ["K", "F", "V", "C"].includes(key.decodeText());
          if ((part === "field" && !fieldEvent) || (part === "widget" && fieldEvent)) continue;
          mapped.set(key, action(value));
        }
        copy.set(name("AA"), mapped);
      }
    }
    form.mapActions(rewriteActions);
    for (const [original, { copy, ref }] of imported) {
      const rect = numbers(original.lookup(name("Rect")), 4);
      if (rect[0] > rect[2] || rect[1] > rect[3]) invalid();
      const widget = original.lookup(name("Subtype"))?.decodeText?.() === "Widget", crop = placement.crop;
      const visible = rect[0] < crop[2] && rect[2] > crop[0] && rect[1] < crop[3] && rect[3] > crop[1];
      if (widget && visible
        && (rect[0] < crop[0] || rect[1] < crop[1] || rect[2] > crop[2] || rect[3] > crop[3])) {
        fail("PIPELINE_PDF_UNSUPPORTED", "Partially cropped editable widgets cannot preserve interactive geometry");
      }
      const clipped = visible ? [Math.max(rect[0], crop[0]), Math.max(rect[1], crop[1]), Math.min(rect[2], crop[2]), Math.min(rect[3], crop[3])] : rect;
      const mappedRect = rectangle(matrix, clipped);
      if (!visible) copy.set(name("F"), document.context.obj((original.lookup(name("F"))?.asNumber?.() || 0) | 2));
      copy.set(name("Rect"), document.context.obj(mappedRect));
      copy.set(name("P"), target.ref);
      if (copy.has(name("AP"))) copy.set(name("AP"), appearance(copy.get(name("AP")), rect, mappedRect, matrix, rectangle(matrix, placement.crop)));
      if (original.has(name("Dest"))) copy.set(name("Dest"), destination(original.get(name("Dest")), placement));
      rewriteActions(original, copy, widget && (original.has(name("T")) || original.has(name("FT"))) ? "widget" : undefined);
      for (const key of ["Popup", "IRT", ...(widget ? [] : ["Parent"])]) {
        if (!original.has(name(key))) continue;
        const linked = imported.get(original.lookup(name(key)));
        if (!linked) invalid();
        copy.set(name(key), linked.ref);
      }
      function points(value, clipQuads = false) {
        const coordinates = numbers(value); budget(coordinates.length);
        if (coordinates.length % 2) invalid();
        if (clipQuads && visible) {
          if (coordinates.length % 8) invalid();
          for (let i = 0; i < coordinates.length; i += 8) {
            const quad = coordinates.slice(i, i + 8);
            const outside = quad.some((v, index) => v < crop[index % 2] || v > crop[index % 2 + 2]);
            if (!outside) continue;
            if (new Set([quad[0], quad[2], quad[4], quad[6]]).size > 2 || new Set([quad[1], quad[3], quad[5], quad[7]]).size > 2) {
              fail("PIPELINE_PDF_UNSUPPORTED", "Clipped nonrectangular annotation quadrilaterals cannot preserve their hit regions");
            }
            for (let j = 0; j < 8; j++) coordinates[i + j] = Math.max(crop[j % 2], Math.min(crop[j % 2 + 2], quad[j]));
          }
        }
        const mapped = [];
        for (let i = 0; i < coordinates.length; i += 2) mapped.push(...point(matrix, coordinates[i], coordinates[i + 1]));
        return document.context.obj(mapped);
      }
      for (const key of ["QuadPoints", "L", "Vertices", "CL"]) if (original.has(name(key))) copy.set(name(key), points(original.lookup(name(key)), key === "QuadPoints"));
      if (original.has(name("RD"))) {
        const inset = numbers(original.lookup(name("RD")), 4);
        const inner = rectangle(matrix, [rect[0] + inset[0], rect[1] + inset[1], rect[2] - inset[2], rect[3] - inset[3]]);
        copy.set(name("RD"), document.context.obj([inner[0] - mappedRect[0], inner[1] - mappedRect[1], mappedRect[2] - inner[2], mappedRect[3] - inner[3]]));
      }
      if (original.has(name("InkList"))) {
        const strokes = original.lookup(name("InkList"), PDFArray); budget(strokes.size());
        copy.set(name("InkList"), document.context.obj(strokes.asArray().map((value, index) => points(strokes.lookup(index)))));
      }
      target.node.addAnnot(ref);
      if (placement.position === "under") {
        const annotations = target.node.Annots(), offset = underlays.get(target) || 0;
        annotations.remove(annotations.size() - 1); annotations.insert(offset, ref); underlays.set(target, offset + 1);
      }
    }
  }
}

module.exports = { copyLayerAnnotations };
