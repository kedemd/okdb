/**
 * The Admin UI (`db.admin`; null when constructed with `admin: false`). Constructed with the
 * OKDB instance: it registers the admin static-file routes, the admin auth guard and the
 * OAuth authorization-server endpoints on `db.http`, and attaches the admin change relay.
 * It has no user-callable methods — the UI is served once `db.http.listen(port)` is called.
 * Removed: `start()` (registration happens in the constructor).
 */
export declare class OKDBAdmin {
    private constructor();
}
