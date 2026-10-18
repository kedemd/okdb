/// <reference types="node" />
// Entry point for `@kedem/okdb`. The runtime module is CommonJS (`module.exports = OKDB`), so the
// declarations use `export =`: `const OKDB = require('@kedem/okdb')`, `import OKDB = require(...)`
// and (with esModuleInterop) `import OKDB from '@kedem/okdb'` all type-check. Every public type is
// reachable as a named type import (`import type { OKDBEnvironment } from '@kedem/okdb'`) or as
// `OKDB.OKDBEnvironment`.
//
// Only the OKDB class is a runtime value. The error classes are types only — the package does not
// export them; match on `err.code` (or `err.name`) at runtime.
//
// When adding an export to any file below, add its alias to the namespace too.

import * as _options from './options';
import * as _errors from './errors';
import * as _environment from './environment';
import * as _okdb from './okdb';
import * as _queue from './features/queue';
import * as _files from './features/files';
import * as _sync from './features/sync';
import * as _auth from './features/auth';
import * as _embeddings from './features/embeddings';
import * as _fts from './features/fts';
import * as _engines from './features/engines';
import * as _functions from './features/functions';
import * as _pipelines from './features/pipelines';
import * as _views from './features/views';
import * as _mcp from './features/mcp';
import * as _timeMachine from './features/time-machine';
import * as _admin from './features/admin';
import * as _api from './features/api';
import * as _licenses from './features/licenses';

declare class OKDB extends _okdb.OKDB {}

declare namespace OKDB {
    // ./options
    export import OKDBPrimaryKey = _options.OKDBPrimaryKey;
    export import OKDBIndexKey = _options.OKDBIndexKey;
    export import OKDBFilter = _options.OKDBFilter;
    export import OKDBIndexSpec = _options.OKDBIndexSpec;
    export import OKDBOptions = _options.OKDBOptions;
    export import OKDBAutoCompactOptions = _options.OKDBAutoCompactOptions;
    export import OKDBAuthOptions = _options.OKDBAuthOptions;
    export import OKDBOAuthConfig = _options.OKDBOAuthConfig;
    export import OKDBOAuthProviderConfig = _options.OKDBOAuthProviderConfig;
    export import OKDBSyncOptions = _options.OKDBSyncOptions;
    export import OKDBQueueOptions = _options.OKDBQueueOptions;
    export import OKDBTimeMachineOptions = _options.OKDBTimeMachineOptions;
    export import OKDBEnvironmentConfig = _options.OKDBEnvironmentConfig;
    export import OKDBSnapshotMode = _options.OKDBSnapshotMode;
    export import OKDBRangeOptions = _options.OKDBRangeOptions;
    export import OKDBQueryFtsSignal = _options.OKDBQueryFtsSignal;
    export import OKDBQueryVectorSignal = _options.OKDBQueryVectorSignal;
    export import OKDBQueryNear = _options.OKDBQueryNear;
    export import OKDBQueryOptions = _options.OKDBQueryOptions;
    export import OKDBHybridQueryOptions = _options.OKDBHybridQueryOptions;
    export import OKDBIndexRangeOptions = _options.OKDBIndexRangeOptions;
    export import OKDBGeoQueryOptions = _options.OKDBGeoQueryOptions;
    export import OKDBFtsQueryOptions = _options.OKDBFtsQueryOptions;
    export import OKDBWriteOptions = _options.OKDBWriteOptions;
    export import OKDBRemoveOptions = _options.OKDBRemoveOptions;
    export import OKDBTransactionOptions = _options.OKDBTransactionOptions;
    export import OKDBRangeIterable = _options.OKDBRangeIterable;
    export import OKDBEntry = _options.OKDBEntry;
    export import OKDBIndexEntry = _options.OKDBIndexEntry;
    export import OKDBQueryEntry = _options.OKDBQueryEntry;
    export import OKDBChangeEntry = _options.OKDBChangeEntry;
    export import OKDBIndexDefinition = _options.OKDBIndexDefinition;
    export import OKDBRegisterIndexOptions = _options.OKDBRegisterIndexOptions;
    export import OKDBTypeSchema = _options.OKDBTypeSchema;
    export import OKDBEnsureDefinition = _options.OKDBEnsureDefinition;
    export import OKDBCompactResult = _options.OKDBCompactResult;
    export import OKDBRemoveEnvironmentResult = _options.OKDBRemoveEnvironmentResult;
    export import OKDBTtlListOptions = _options.OKDBTtlListOptions;
    export import OKDBTtlInfo = _options.OKDBTtlInfo;
    export import OKDBTtlListResult = _options.OKDBTtlListResult;
    export import OKDBTtlStats = _options.OKDBTtlStats;
    export import OKDBTtlSweepResult = _options.OKDBTtlSweepResult;
    export import OKDBResolvedOptions = _options.OKDBResolvedOptions;
    export import OKDBRoleFlags = _options.OKDBRoleFlags;
    export import OKDBInfoResult = _options.OKDBInfoResult;
    // ./errors
    export type OKDBError = _errors.OKDBError;
    export type OKDBVersionMismatchError = _errors.OKDBVersionMismatchError;
    export type OKDBNotFoundError = _errors.OKDBNotFoundError;
    export type OKDBAlreadyExistsError = _errors.OKDBAlreadyExistsError;
    export type OKDBInvalidIndexKeyError = _errors.OKDBInvalidIndexKeyError;
    export type OKDBInvalidPrimaryKeyError = _errors.OKDBInvalidPrimaryKeyError;
    export type OKDBTypeNotRegisteredError = _errors.OKDBTypeNotRegisteredError;
    export type OKDBTypeAlreadyRegisteredError = _errors.OKDBTypeAlreadyRegisteredError;
    export type OKDBIndexNotRegisteredError = _errors.OKDBIndexNotRegisteredError;
    export type OKDBIndexAlreadyRegisteredError = _errors.OKDBIndexAlreadyRegisteredError;
    export type OKDBInvalidValueError = _errors.OKDBInvalidValueError;
    export type OKDBUniqueConstraintError = _errors.OKDBUniqueConstraintError;
    export type OKDBSchemaValidationError = _errors.OKDBSchemaValidationError;
    export type OKDBSchemaCollectionError = _errors.OKDBSchemaCollectionError;
    export type OKDBForeignKeyError = _errors.OKDBForeignKeyError;
    export type OKDBForeignKeyDeleteError = _errors.OKDBForeignKeyDeleteError;
    export type OKDBIndexHasConsumersError = _errors.OKDBIndexHasConsumersError;
    // ./environment
    export import OKDBTransactionOps = _environment.OKDBTransactionOps;
    export import OKDBTransaction = _environment.OKDBTransaction;
    export import OKDBTransactionFacade = _environment.OKDBTransactionFacade;
    export import OKDBTransactionOp = _environment.OKDBTransactionOp;
    export import OKDBTxnResult = _environment.OKDBTxnResult;
    export import OKDBProcessorHandler = _environment.OKDBProcessorHandler;
    export import OKDBProcessorRegisterOptions = _environment.OKDBProcessorRegisterOptions;
    export import OKDBProcessorStatus = _environment.OKDBProcessorStatus;
    export import OKDBProcessorHandle = _environment.OKDBProcessorHandle;
    export import OKDBEnvProcessor = _environment.OKDBEnvProcessor;
    export import OKDBStorageStats = _environment.OKDBStorageStats;
    export import OKDBWriterStatus = _environment.OKDBWriterStatus;
    export import OKDBEnvironment = _environment.OKDBEnvironment;
    // ./okdb
    export import OKDBHttpRequest = _okdb.OKDBHttpRequest;
    export import OKDBHttpResponse = _okdb.OKDBHttpResponse;
    export import OKDBHttpRouteHandler = _okdb.OKDBHttpRouteHandler;
    export import OKDBHttp = _okdb.OKDBHttp;
    export import OKDBProcessors = _okdb.OKDBProcessors;
    export import OKDBPressure = _okdb.OKDBPressure;
    // ./features/queue
    export import OKDBJobStatus = _queue.OKDBJobStatus;
    export import OKDBJobBucket = _queue.OKDBJobBucket;
    export import OKDBJob = _queue.OKDBJob;
    export import OKDBJobBucketRecord = _queue.OKDBJobBucketRecord;
    export import OKDBJobTypeStatus = _queue.OKDBJobTypeStatus;
    export import OKDBJobType = _queue.OKDBJobType;
    export import OKDBJobDefaults = _queue.OKDBJobDefaults;
    export import OKDBEnqueueOptions = _queue.OKDBEnqueueOptions;
    export import OKDBClaimOptions = _queue.OKDBClaimOptions;
    export import OKDBListJobsOptions = _queue.OKDBListJobsOptions;
    export import OKDBUpdateJobPatch = _queue.OKDBUpdateJobPatch;
    export import OKDBAddBucketOptions = _queue.OKDBAddBucketOptions;
    export import OKDBAddJobTypeOptions = _queue.OKDBAddJobTypeOptions;
    export import OKDBQueueTransaction = _queue.OKDBQueueTransaction;
    export import OKDBJobLogLevel = _queue.OKDBJobLogLevel;
    export import OKDBJobLogInput = _queue.OKDBJobLogInput;
    export import OKDBJobLogEntry = _queue.OKDBJobLogEntry;
    export import OKDBQueueHandlerContext = _queue.OKDBQueueHandlerContext;
    export import OKDBQueueHandler = _queue.OKDBQueueHandler;
    export import OKDBQueueLaneOptions = _queue.OKDBQueueLaneOptions;
    export import OKDBQueuePoolOptions = _queue.OKDBQueuePoolOptions;
    export import OKDBQueueProcessOptions = _queue.OKDBQueueProcessOptions;
    export import OKDBQueuePoolLane = _queue.OKDBQueuePoolLane;
    export import OKDBQueueConsumer = _queue.OKDBQueueConsumer;
    export import OKDBQueueEventName = _queue.OKDBQueueEventName;
    export type OKDBQueue = _queue.OKDBQueue;
    // ./features/files
    export import OKDBFileRecord = _files.OKDBFileRecord;
    export import OKDBUploadOptions = _files.OKDBUploadOptions;
    export import OKDBBlobStatus = _files.OKDBBlobStatus;
    export import OKDBIndexContentOptions = _files.OKDBIndexContentOptions;
    export import OKDBExtractorMatch = _files.OKDBExtractorMatch;
    export import OKDBExtractor = _files.OKDBExtractor;
    export type OKDBFiles = _files.OKDBFiles;
    // ./features/sync
    export import OKDBSyncNode = _sync.OKDBSyncNode;
    export import OKDBSyncInfo = _sync.OKDBSyncInfo;
    export import OKDBSyncLinkDirection = _sync.OKDBSyncLinkDirection;
    export import OKDBSyncLink = _sync.OKDBSyncLink;
    export import OKDBSyncLinkOptions = _sync.OKDBSyncLinkOptions;
    export import OKDBSyncPeer = _sync.OKDBSyncPeer;
    export import OKDBSyncJoinOptions = _sync.OKDBSyncJoinOptions;
    export import OKDBSyncChange = _sync.OKDBSyncChange;
    export import OKDBSyncDelta = _sync.OKDBSyncDelta;
    export import OKDBSyncPeerAck = _sync.OKDBSyncPeerAck;
    export import OKDBSyncGcResult = _sync.OKDBSyncGcResult;
    export import OKDBSyncGcStatus = _sync.OKDBSyncGcStatus;
    export type OKDBSyncGC = _sync.OKDBSyncGC;
    export type OKDBSync = _sync.OKDBSync;
    // ./features/auth
    export import OKDBToken = _auth.OKDBToken;
    export import OKDBAuthUser = _auth.OKDBAuthUser;
    export import OKDBAuthContext = _auth.OKDBAuthContext;
    export import OKDBLoginResult = _auth.OKDBLoginResult;
    export import OKDBSessionClaims = _auth.OKDBSessionClaims;
    export import OKDBSecurityNotice = _auth.OKDBSecurityNotice;
    export import OKDBLoginConfig = _auth.OKDBLoginConfig;
    export type OKDBAuth = _auth.OKDBAuth;
    // ./features/embeddings
    export import OKDBEmbeddingsQuery = _embeddings.OKDBEmbeddingsQuery;
    export import OKDBEmbeddingsDocStatus = _embeddings.OKDBEmbeddingsDocStatus;
    export import OKDBEmbeddingsPreparer = _embeddings.OKDBEmbeddingsPreparer;
    export import OKDBEmbeddingsChunkConfig = _embeddings.OKDBEmbeddingsChunkConfig;
    export import OKDBEmbeddingsChunk = _embeddings.OKDBEmbeddingsChunk;
    export import OKDBEmbeddingsEmbedderConfig = _embeddings.OKDBEmbeddingsEmbedderConfig;
    export import OKDBEmbeddingsWorkerConfig = _embeddings.OKDBEmbeddingsWorkerConfig;
    export import OKDBEmbeddingsPipelineConfig = _embeddings.OKDBEmbeddingsPipelineConfig;
    export import OKDBEmbeddingsEngine = _embeddings.OKDBEmbeddingsEngine;
    export import OKDBEmbeddingsPipelineApi = _embeddings.OKDBEmbeddingsPipelineApi;
    export import OKDBEmbeddingsPipelineResult = _embeddings.OKDBEmbeddingsPipelineResult;
    export import OKDBEmbeddingsPipeline = _embeddings.OKDBEmbeddingsPipeline;
    export import OKDBEmbedderHealth = _embeddings.OKDBEmbedderHealth;
    export import OKDBEmbedderApi = _embeddings.OKDBEmbedderApi;
    export import OKDBEmbeddingsDocCounts = _embeddings.OKDBEmbeddingsDocCounts;
    export import OKDBEmbeddingsIndexerStats = _embeddings.OKDBEmbeddingsIndexerStats;
    export import OKDBEmbeddingsDocStatusEntry = _embeddings.OKDBEmbeddingsDocStatusEntry;
    export import OKDBEmbeddingsRetryFailedOptions = _embeddings.OKDBEmbeddingsRetryFailedOptions;
    export import OKDBEmbeddingsRetryFailedResult = _embeddings.OKDBEmbeddingsRetryFailedResult;
    export import OKDBEmbeddingsIndexerApi = _embeddings.OKDBEmbeddingsIndexerApi;
    export import OKDBEmbeddingsWorkerStats = _embeddings.OKDBEmbeddingsWorkerStats;
    export import OKDBEmbeddingsWorkerApi = _embeddings.OKDBEmbeddingsWorkerApi;
    export import OKDBEmbeddingsSearchOptions = _embeddings.OKDBEmbeddingsSearchOptions;
    export import OKDBEmbeddingsSearchResult = _embeddings.OKDBEmbeddingsSearchResult;
    export import OKDBEmbeddingsDocSearchResult = _embeddings.OKDBEmbeddingsDocSearchResult;
    export import OKDBEmbeddingsSearchStats = _embeddings.OKDBEmbeddingsSearchStats;
    export import OKDBEmbeddingsSearchApi = _embeddings.OKDBEmbeddingsSearchApi;
    export import OKDBEmbedderImpl = _embeddings.OKDBEmbedderImpl;
    export import OKDBEmbedderFactory = _embeddings.OKDBEmbedderFactory;
    export import OKDBEmbeddingsSchemaField = _embeddings.OKDBEmbeddingsSchemaField;
    export import OKDBEmbedderSchema = _embeddings.OKDBEmbedderSchema;
    export import OKDBEmbeddingsProvider = _embeddings.OKDBEmbeddingsProvider;
    export import OKDBAlgorithmFactory = _embeddings.OKDBAlgorithmFactory;
    export import OKDBAlgorithmSchema = _embeddings.OKDBAlgorithmSchema;
    export import OKDBEmbeddingsAlgorithmInfo = _embeddings.OKDBEmbeddingsAlgorithmInfo;
    export import OKDBEmbeddingsModel = _embeddings.OKDBEmbeddingsModel;
    export import OKDBVectorStorageAdapter = _embeddings.OKDBVectorStorageAdapter;
    export import OKDBVectorStorageResolver = _embeddings.OKDBVectorStorageResolver;
    export import OKDBVectorStoreStats = _embeddings.OKDBVectorStoreStats;
    export import OKDBEmbeddingsDurableRebuildResult = _embeddings.OKDBEmbeddingsDurableRebuildResult;
    export type OKDBEmbeddings = _embeddings.OKDBEmbeddings;
    // ./features/fts
    export import OKDBFtsEnvArg = _fts.OKDBFtsEnvArg;
    export import OKDBFtsTokenizerOptions = _fts.OKDBFtsTokenizerOptions;
    export import OKDBFtsConfig = _fts.OKDBFtsConfig;
    export import OKDBFtsIndexStatus = _fts.OKDBFtsIndexStatus;
    export import OKDBFtsListEntry = _fts.OKDBFtsListEntry;
    export import OKDBFtsIndex = _fts.OKDBFtsIndex;
    export import OKDBFtsSearchOptions = _fts.OKDBFtsSearchOptions;
    export import OKDBFtsSearchResult = _fts.OKDBFtsSearchResult;
    export import OKDBFtsQueryResult = _fts.OKDBFtsQueryResult;
    export import OKDBFtsEnvSize = _fts.OKDBFtsEnvSize;
    export import OKDBFtsCompactResult = _fts.OKDBFtsCompactResult;
    export type OKDBFts = _fts.OKDBFts;
    // ./features/engines
    export import OKDBEngineStatus = _engines.OKDBEngineStatus;
    export import OKDBEngineUpdatableStatus = _engines.OKDBEngineUpdatableStatus;
    export import OKDBEngineEvent = _engines.OKDBEngineEvent;
    export import OKDBEngineDefinition = _engines.OKDBEngineDefinition;
    export import OKDBEngineDocEntry = _engines.OKDBEngineDocEntry;
    export import OKDBEngineRuntimeState = _engines.OKDBEngineRuntimeState;
    export import OKDBEngineCreateOptions = _engines.OKDBEngineCreateOptions;
    export import OKDBEngineDeclarationPatch = _engines.OKDBEngineDeclarationPatch;
    export import OKDBEngineApi = _engines.OKDBEngineApi;
    export import OKDBEngine = _engines.OKDBEngine;
    export import OKDBEngineDriverDocs = _engines.OKDBEngineDriverDocs;
    export import OKDBEngineDriverContext = _engines.OKDBEngineDriverContext;
    export import OKDBEngineCreateContext = _engines.OKDBEngineCreateContext;
    export import OKDBEngineConfigPatchContext = _engines.OKDBEngineConfigPatchContext;
    export import OKDBEngineDriver = _engines.OKDBEngineDriver;
    export import OKDBEngineCatalogEntry = _engines.OKDBEngineCatalogEntry;
    export import OKDBEngineTemplatePlan = _engines.OKDBEngineTemplatePlan;
    export import OKDBEngineTemplateDefinition = _engines.OKDBEngineTemplateDefinition;
    export import OKDBEngineTemplate = _engines.OKDBEngineTemplate;
    export import OKDBEngineTemplatePreview = _engines.OKDBEngineTemplatePreview;
    export type OKDBEngines = _engines.OKDBEngines;
    // ./features/functions
    export import OKDBFunctionRuntime = _functions.OKDBFunctionRuntime;
    export import OKDBFunctionDefinition = _functions.OKDBFunctionDefinition;
    export import OKDBFunctionRecord = _functions.OKDBFunctionRecord;
    export import OKDBFunctionRegistryEntry = _functions.OKDBFunctionRegistryEntry;
    export import OKDBFunctionRunStatus = _functions.OKDBFunctionRunStatus;
    export import OKDBFunctionLogEntry = _functions.OKDBFunctionLogEntry;
    export import OKDBFunctionDryRunAction = _functions.OKDBFunctionDryRunAction;
    export import OKDBFunctionRun = _functions.OKDBFunctionRun;
    export import OKDBFunctionRunOptions = _functions.OKDBFunctionRunOptions;
    export import OKDBFunctionPreviewOptions = _functions.OKDBFunctionPreviewOptions;
    export type OKDBFunctions = _functions.OKDBFunctions;
    // ./features/pipelines
    export import OKDBPipelineStatus = _pipelines.OKDBPipelineStatus;
    export import OKDBPipelineMemberRef = _pipelines.OKDBPipelineMemberRef;
    export import OKDBPipelineDefinition = _pipelines.OKDBPipelineDefinition;
    export import OKDBPipelineRecord = _pipelines.OKDBPipelineRecord;
    export import OKDBPipelineUpdatePatch = _pipelines.OKDBPipelineUpdatePatch;
    export import OKDBPipelineRecordEntry = _pipelines.OKDBPipelineRecordEntry;
    export import OKDBPipelineMemberState = _pipelines.OKDBPipelineMemberState;
    export import OKDBPipelineHealth = _pipelines.OKDBPipelineHealth;
    export import OKDBPipelineMemberInfo = _pipelines.OKDBPipelineMemberInfo;
    export import OKDBPipelineInfo = _pipelines.OKDBPipelineInfo;
    export import OKDBPipelineRebuildResult = _pipelines.OKDBPipelineRebuildResult;
    export import OKDBPipelineRemoveResult = _pipelines.OKDBPipelineRemoveResult;
    export import OKDBPipelineOwner = _pipelines.OKDBPipelineOwner;
    export import OKDBPipelineSearchOptions = _pipelines.OKDBPipelineSearchOptions;
    export import OKDBPipelineSearchHit = _pipelines.OKDBPipelineSearchHit;
    export import OKDBPipelineDocHit = _pipelines.OKDBPipelineDocHit;
    export import OKDBPipelineApi = _pipelines.OKDBPipelineApi;
    export import OKDBPipelineHandle = _pipelines.OKDBPipelineHandle;
    export type OKDBPipelines = _pipelines.OKDBPipelines;
    // ./features/views
    export import OKDBMapRefSpec = _views.OKDBMapRefSpec;
    export import OKDBMapConcatSpec = _views.OKDBMapConcatSpec;
    export import OKDBMapCoalesceSpec = _views.OKDBMapCoalesceSpec;
    export import OKDBMapFieldSpec = _views.OKDBMapFieldSpec;
    export import OKDBViewMap = _views.OKDBViewMap;
    export import OKDBReducerCommon = _views.OKDBReducerCommon;
    export import OKDBCountSpec = _views.OKDBCountSpec;
    export import OKDBSumSpec = _views.OKDBSumSpec;
    export import OKDBAvgSpec = _views.OKDBAvgSpec;
    export import OKDBMinSpec = _views.OKDBMinSpec;
    export import OKDBMaxSpec = _views.OKDBMaxSpec;
    export import OKDBCountBySpec = _views.OKDBCountBySpec;
    export import OKDBGroupSpec = _views.OKDBGroupSpec;
    export import OKDBCustomSpec = _views.OKDBCustomSpec;
    export import OKDBRefSpec = _views.OKDBRefSpec;
    export import OKDBReducerSpec = _views.OKDBReducerSpec;
    export import OKDBBucketTimeGranularity = _views.OKDBBucketTimeGranularity;
    export import OKDBBucketConfig = _views.OKDBBucketConfig;
    export import OKDBBucketRangeOptions = _views.OKDBBucketRangeOptions;
    export import OKDBBucketRangeEntry = _views.OKDBBucketRangeEntry;
    export import OKDBListBucketsOptions = _views.OKDBListBucketsOptions;
    export import OKDBBucketEntry = _views.OKDBBucketEntry;
    export import OKDBViewDefinition = _views.OKDBViewDefinition;
    export import OKDBViewItemsOptions = _views.OKDBViewItemsOptions;
    export import OKDBViewItemsPage = _views.OKDBViewItemsPage;
    export import OKDBViewItemsFn = _views.OKDBViewItemsFn;
    export import OKDBScalarResult = _views.OKDBScalarResult;
    export import OKDBViewPreviewOptions = _views.OKDBViewPreviewOptions;
    export import OKDBCountByPreviewEntry = _views.OKDBCountByPreviewEntry;
    export import OKDBGroupPreviewEntry = _views.OKDBGroupPreviewEntry;
    export import OKDBCountByResult = _views.OKDBCountByResult;
    export import OKDBGroupResult = _views.OKDBGroupResult;
    export import OKDBGroupedResult = _views.OKDBGroupedResult;
    export import OKDBRefResult = _views.OKDBRefResult;
    export import OKDBViewOutput = _views.OKDBViewOutput;
    export import OKDBViewState = _views.OKDBViewState;
    export import OKDBViewBootstrapProgress = _views.OKDBViewBootstrapProgress;
    export import OKDBViewSectionState = _views.OKDBViewSectionState;
    export import OKDBViewMeta = _views.OKDBViewMeta;
    export import OKDBViewProgressEvent = _views.OKDBViewProgressEvent;
    export import OKDBStoredViewDefinition = _views.OKDBStoredViewDefinition;
    export import OKDBViewItemsGroupsOptions = _views.OKDBViewItemsGroupsOptions;
    export import OKDBViewItemsGroupsPage = _views.OKDBViewItemsGroupsPage;
    export import OKDBViewRemoveOptions = _views.OKDBViewRemoveOptions;
    export import OKDBCustomReducer = _views.OKDBCustomReducer;
    export type OKDBViews = _views.OKDBViews;
    // ./features/mcp
    export import OKDBMcpTool = _mcp.OKDBMcpTool;
    export type OKDBMcp = _mcp.OKDBMcp;
    // ./features/time-machine
    export import OKDBTimeMachineSnapshot = _timeMachine.OKDBTimeMachineSnapshot;
    export import OKDBTimeMachineDiff = _timeMachine.OKDBTimeMachineDiff;
    export import OKDBTimeMachineChange = _timeMachine.OKDBTimeMachineChange;
    export import OKDBTimeMachineHistoryOptions = _timeMachine.OKDBTimeMachineHistoryOptions;
    export import OKDBTimeMachineHistory = _timeMachine.OKDBTimeMachineHistory;
    export import OKDBTimeMachineTypeListEntry = _timeMachine.OKDBTimeMachineTypeListEntry;
    export import OKDBTimeMachineTypeStatus = _timeMachine.OKDBTimeMachineTypeStatus;
    export import OKDBTimeMachineStatus = _timeMachine.OKDBTimeMachineStatus;
    export type OKDBTimeMachine = _timeMachine.OKDBTimeMachine;
    // ./features/admin
    export type OKDBAdmin = _admin.OKDBAdmin;
    // ./features/api
    export type OKDBApi = _api.OKDBApi;
    // ./features/licenses
    export import OKDBLicenseFeatures = _licenses.OKDBLicenseFeatures;
    export import OKDBLicenseLimits = _licenses.OKDBLicenseLimits;
    export import OKDBLicenseSummary = _licenses.OKDBLicenseSummary;
    export import OKDBLicenseChange = _licenses.OKDBLicenseChange;
    export import OKDBEffectiveLicense = _licenses.OKDBEffectiveLicense;
    export import OKDBLicenses = _licenses.OKDBLicenses;
}

export = OKDB;
