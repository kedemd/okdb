/**
 * The REST API route set (`db.api`). Constructed with the OKDB instance: it registers the
 * `/api/*` auth guard and routes (envs, types, items, indexes, FTS, views, functions,
 * subscriptions, processors, auth, system) on `db.http`. It has no user-callable methods —
 * the routes are served once `db.http.listen(port)` is called. The default env for routes
 * without an `/env/:env` prefix comes from the `api.defaultEnv` constructor option
 * (default `'default'`).
 * Removed: `start()` and `inferSchema()` (never existed on the 2.x class).
 */
export declare class OKDBApi {
    private constructor();
}
