/**
 * `db.admin` — in okdb 3.0 a stub (null when constructed with `admin: false`): any member call
 * throws `NOT_IMPLEMENTED_NATIVE`. The admin UI, its auth guard and the OAuth endpoints are built
 * into the native HTTP server and served once `db.http.listen(port)` is called.
 */
export declare class OKDBAdmin {
    private constructor();
}
