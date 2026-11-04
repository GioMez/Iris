const { isUuid } = require("../ids");
const { cloneValue, readPolicy, LUA_DATA_POLICY, record, name, freeze, fail } = require("./contracts");

const INVALID = "PIPELINE_LAYOUT_INVALID";
const MEDIA_TYPE = "application/vnd.iris.layout+json";
const COVERAGE = new Set(["complete", "partial", "unavailable"]);
const KINDS = new Set(["path", "stroke", "text", "text-stroke", "image", "image-mask", "shade", "conservative"]);
function requireValue(condition) {
  if (!condition) fail(INVALID, "Invalid artifact-bound layout");
}
function box(value) {
  requireValue(Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)
    && value[0] < value[2] && value[1] < value[3]);
}
function coverage(value) {
  requireValue(COVERAGE.has(value.coverage) && Array.isArray(value.reasons)
    && new Set(value.reasons).size === value.reasons.length);
  for (const reason of value.reasons) name(reason, INVALID);
  requireValue(value.coverage === "complete" ? value.reasons.length === 0 : value.reasons.length > 0);
}

// Page boxes retain PDF user-space coordinates. Occupied bounds and dimensions
// use physical 1/72-inch points from the unrotated MediaBox's top-left.
function validateLayout(value, { artifact, requirements = [], policy } = {}) {
  const result = cloneValue(value, readPolicy({ ...LUA_DATA_POLICY, ...policy }), INVALID);
  record(result, ["version", "artifact", "units", "origin", "collector", "coverage", "reasons", "pageCount", "pages"], INVALID, "layout");
  requireValue(result.version === 1 && result.units === "pdf-point" && result.origin === "media-box-top-left");
  record(result.artifact, ["id", "contentHash"], INVALID, "layout artifact");
  requireValue(isUuid(result.artifact.id) && /^[a-f0-9]{64}$/.test(result.artifact.contentHash)
    && artifact?.mediaType === "application/pdf" && artifact.id === result.artifact.id && artifact.contentHash === result.artifact.contentHash);
  record(result.collector, ["id", "version"], INVALID, "layout collector");
  name(result.collector.id, INVALID); name(result.collector.version, INVALID);
  coverage(result);
  requireValue(Array.isArray(result.pages));
  if (result.pageCount === null) requireValue(result.coverage === "unavailable" && result.pages.length === 0);
  else requireValue(Number.isSafeInteger(result.pageCount) && result.pageCount > 0 && result.pages.length === result.pageCount);
  for (const [index, page] of result.pages.entries()) {
    record(page, ["page", "mediaBox", "cropBox", "rotation", "userUnit", "width", "height", "coverage", "reasons", "occupied"], INVALID, "layout page");
    requireValue(page.page === index + 1);
    box(page.mediaBox); box(page.cropBox);
    requireValue([0, 90, 180, 270].includes(page.rotation) && Number.isFinite(page.userUnit) && page.userUnit > 0 && page.userUnit <= 75000);
    requireValue(Number.isFinite(page.width) && Number.isFinite(page.height)
      && page.width === (page.mediaBox[2] - page.mediaBox[0]) * page.userUnit
      && page.height === (page.mediaBox[3] - page.mediaBox[1]) * page.userUnit);
    coverage(page);
    requireValue(Array.isArray(page.occupied) && (page.coverage !== "unavailable" || page.occupied.length === 0));
    for (const region of page.occupied) {
      record(region, ["kind", "bounds"], INVALID, "occupied region");
      requireValue(KINDS.has(region.kind)); box(region.bounds);
      requireValue(region.bounds[0] >= 0 && region.bounds[1] >= 0 && region.bounds[2] <= page.width && region.bounds[3] <= page.height);
    }
    for (const reason of page.reasons) requireValue(result.reasons.includes(reason));
  }
  if (result.pages.length) {
    const expected = result.pages.every(page => page.coverage === "unavailable") ? "unavailable"
      : result.pages.every(page => page.coverage === "complete") && !result.reasons.length ? "complete" : "partial";
    requireValue(result.coverage === expected);
  }
  requireValue(Array.isArray(requirements) && requirements.every(item => typeof item === "string"));
  const capabilities = new Set();
  if (result.pages.length) capabilities.add("layout.pages");
  if (result.coverage !== "unavailable") capabilities.add("layout.occupied");
  if (result.coverage === "complete") capabilities.add("layout.occupied.complete");
  if (requirements.some(item => !capabilities.has(item))) fail("PIPELINE_LAYOUT_CAPABILITY_UNAVAILABLE", "Required layout coverage is unavailable");
  return freeze(result);
}

function collectLayout({ compilerResult, artifact, collectorData, policy, requirements }) {
  if (compilerResult?.code !== 0 || compilerResult.signal || compilerResult.timedOut) {
    fail("PIPELINE_LAYOUT_COMPILE_FAILED", "Layout requires a successful final compiler pass");
  }
  return validateLayout(collectorData ?? { version: 1, artifact: { id: artifact.id, contentHash: artifact.contentHash },
    units: "pdf-point", origin: "media-box-top-left", collector: { id: "mupdf", version: "1.28.1" },
    coverage: "unavailable", reasons: ["collector-error"], pageCount: null, pages: [],
  }, { artifact, policy, requirements });
}

module.exports = { validateLayout, collectLayout, MEDIA_TYPE };
