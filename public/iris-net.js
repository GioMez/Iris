/* ===================== Iris · net ===================== */
/* Un solo wrapper fetch, condiviso da auth/admin/projects. Centralizza la
   gestione del 401 (sessione scaduta, account disabilitato, logout forzato dopo
   reset password): chi gestisce l'autenticazione registra un hook e ogni
   chiamata autenticata lo rispetta. Gli endpoint di login/sessione, che usano il
   401 per segnalare credenziali errate, passano `skipUnauthorizedHook: true`. */
(function () {
  let onUnauthorized = null;

  // Registered by IrisAuth: what to run when an authed request returns 401.
  function setUnauthorizedHandler(fn) {
    onUnauthorized = typeof fn === "function" ? fn : null;
  }

  // Fires the handler for a 401, unless the caller opted out.
  function handleStatus(status, skip) {
    if (status === 401 && !skip && onUnauthorized) onUnauthorized();
  }

  // Builds the typed error the UI expects (err.code / err.params / err.status),
  // with a localized message resolved once here.
  function buildError(status, data) {
    const err = new Error();
    err.code = (data && data.errorCode) || "SERVER_ERROR";
    err.params = (data && data.params) || {};
    err.status = status;
    err.message = window.IrisI18n.error(err);
    return err;
  }

  async function request(path, options) {
    const { skipUnauthorizedHook, ...init } = options || {};
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...init.headers },
      ...init,
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      handleStatus(res.status, skipUnauthorizedHook);
      throw buildError(res.status, data);
    }
    return data;
  }

  // For callers that read the body themselves (binary downloads): reuses the
  // same 401 routing and error shape from a raw Response.
  async function errorFromResponse(res, skipUnauthorizedHook) {
    let data = {};
    try { data = await res.json(); } catch (e) {}
    handleStatus(res.status, skipUnauthorizedHook);
    return buildError(res.status, data);
  }

  window.IrisNet = { request, errorFromResponse, setUnauthorizedHandler };
})();
