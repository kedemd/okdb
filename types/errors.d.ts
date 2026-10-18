import type { OKDBPrimaryKey } from './options';

export declare class OKDBError extends Error {
    name: string;
    code: string;
    details: Record<string, unknown>;
    cause?: Error;
    constructor(message: string, code: string, details?: Record<string, unknown>);
}

export declare class OKDBVersionMismatchError extends OKDBError {
    constructor(type: string, key: OKDBPrimaryKey, expectedVersion: number, actualVersion: number);
}

export declare class OKDBNotFoundError extends OKDBError {
    constructor(type: string, key: OKDBPrimaryKey);
}

export declare class OKDBAlreadyExistsError extends OKDBError {
    constructor(type: string, key: OKDBPrimaryKey);
}

export declare class OKDBInvalidIndexKeyError extends OKDBError {
    constructor(index: string, key: unknown);
}

export declare class OKDBInvalidPrimaryKeyError extends OKDBError {
    constructor(key: unknown);
}

export declare class OKDBTypeNotRegisteredError extends OKDBError {
    constructor(type: string);
}

export declare class OKDBTypeAlreadyRegisteredError extends OKDBError {
    constructor(type: string);
}

export declare class OKDBIndexNotRegisteredError extends OKDBError {
    constructor(type: string, index: string);
}

export declare class OKDBIndexAlreadyRegisteredError extends OKDBError {
    constructor(type: string, index: string);
}

export declare class OKDBInvalidValueError extends OKDBError {
    constructor(message: string, details?: Record<string, unknown>);
}

export declare class OKDBUniqueConstraintError extends OKDBError {
    constructor(
        type: string,
        index: string,
        indexKey: unknown,
        existingKey: OKDBPrimaryKey,
        conflictingKey: OKDBPrimaryKey,
    );
}

export declare class OKDBSchemaValidationError extends OKDBError {
    type: string;
    key: OKDBPrimaryKey;
    errors: unknown[];
    constructor(type: string, key: OKDBPrimaryKey, errors: unknown[]);
}

export declare class OKDBSchemaCollectionError extends OKDBError {
    type: string;
    failures: unknown[];
    constructor(type: string, failures: unknown[]);
}

export declare class OKDBForeignKeyError extends OKDBError {
    sourceType: string;
    sourceKey: OKDBPrimaryKey;
    fieldPath: string;
    targetType: string;
    targetKey: OKDBPrimaryKey;
    constructor(
        sourceType: string,
        sourceKey: OKDBPrimaryKey,
        fieldPath: string,
        targetType: string,
        targetKey: OKDBPrimaryKey,
    );
}

export declare class OKDBForeignKeyDeleteError extends OKDBError {
    targetType: string;
    targetKey: OKDBPrimaryKey;
    references: unknown[];
    constructor(targetType: string, targetKey: OKDBPrimaryKey, references: unknown[]);
}

export declare class OKDBIndexHasConsumersError extends OKDBError {
    constructor(type: string, index: string, usedBy: Array<{ kind: string; name: string }>);
}
