/**
 * Next Watch Helper v2.2.3
 * Google Apps Script web app for governed Next Watch operations.
 *
 * Supported operations:
 *   GET  ?action=health
 *   GET  (no action) -> private operator UI
 *   POST {action:"maintenance", mode:"full", operationId, idempotencyKey}
 *   POST {action:"maintenance", mode:"dynamic_refresh", scope:"all|movies|tv",
 *         operationId, idempotencyKey, dryRun:true, offset:0, limit:100}
 *   POST {action:"run_dynamic_maintenance_dry_run", operationId, idempotencyKey,
 *         scope:"all|movies|tv", offset:0, limit:100}
 *   POST {action:"commit_dynamic_resolutions", sourceCycleId, operationId, idempotencyKey}
 *   POST {action:"rebuild_dynamic_runtime_views", sourceCycleId, operationId, idempotencyKey}
 *   POST {action:"finalize_dynamic_refresh_cycle", sourceCycleId, operationId, idempotencyKey}
 *   POST {action:"collect_dynamic_observations_full_batch", cycleId, batchSize, ...}
 *   POST {action:"refresh_streaming_services", dryRun:true, offset:0, limit:100, ...}
 *
 * Important:
 *   MNT013 records TMDb availability observations and a Refresh Cycles row.
 *   It remains observation-only and does not commit canonical Dynamic Availability.
 */

const NW = Object.freeze({
  VERSION: '2.2.3',
  REPOSITORY_TITLE: 'Next Watch Master v5',
  REPOSITORY_VERSION: '5.3 Production',
  CERTIFICATION_TEXT: 'CERTIFIED',
  VIEW_BASELINE: 'VIEW — Watched Movies',
  BUILD_RUNS: 'Build Runs',
  AUDIT_LOG: 'Audit Log',
  WORK_LOG: 'Work Log',
  TITLE_CATALOG: 'Title Catalog',
  TITLE_STATE: 'Title State',
  TITLE_INTELLIGENCE: 'Title Intelligence',
  DYNAMIC_AVAILABILITY: 'Dynamic Availability',
  PEOPLE: 'People',
  TITLE_PEOPLE: 'Title People',
  REFRESH_CYCLES: 'Refresh Cycles',
  DYNAMIC_OBSERVATIONS: 'Dynamic Observations',
  DYNAMIC_RESOLUTIONS: 'Dynamic Resolutions',
  VIEW_BUILDER_RULES: 'View Builder Rules',
  SUPPORTED_BUILDER_TYPES: [
    'DASHBOARD_MEMBERSHIP','VIEW_SELECTION','INTELLIGENCE_ROLLING_WINDOW',
    'TITLE_STATE_WATCHED','TITLE_STATE_PENDING','TITLE_STATE_DEFERRED',
    'AUDIOBOOK','CANON'
  ],
  LOCK_WAIT_MS: 30000,
  DAILY_TRIGGER_HANDLER: 'runDailyMaintenance',
  DAILY_TRIGGER_HOUR: 5,
  DAILY_TRIGGER_NEAR_MINUTE: 0,
  ORCHESTRATION_LEASE_MINUTES: 120,
  DEFAULT_BATCH_SIZE: 25,
  TRANSIENT_RETRY_MAX_ATTEMPTS: 3,
  TRANSIENT_RETRY_DELAYS_MS: [60 * 1000, 3 * 60 * 1000, 10 * 60 * 1000],
  TIMEZONE: 'America/Los_Angeles',
  THEATRICAL_RELEASE_WINDOW_DAYS: 21, // DRP004 v1.1 governed rolling theatrical/streaming release window
  IDEMPOTENCY_RETENTION_DAYS: 30,
  IDEMPOTENCY_MAX_RECEIPTS: 50,
  PROPERTY_STORAGE_TARGET_BYTES: 100 * 1024,
  PROPERTY_STORAGE_WARNING_BYTES: 150 * 1024,
  PROPERTY_STORAGE_EMERGENCY_BYTES: 200 * 1024,
  WMV2_HEADERS: [
    'Rank','Title ID','Title','Display Synopsis','Key Cast','Status',
    'Ed Rating / Prediction','RT Audience Score','Confidence','Where to Watch',
    'Why Recommended','Primary Concern','Last Verified','Official Synopsis',
    'Year','Genres','Watch Date','Progress / Scope','Notes'
  ]
});

function doGet(e) {
  const action = String((e && e.parameter && e.parameter.action) || '').trim();
  if (action === 'health') return jsonOutput_(health_());
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Next Watch Helper')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function doPost(e) {
  try {
    const body = parseJsonBody_(e);
    authenticateExternal_(body);
    const result = route_(body);
    return jsonOutput_(result);
  } catch (err) {
    return jsonOutput_({
      ok: false,
      error: String(err && err.message ? err.message : err),
      timestamp: now_(),
      helperVersion: NW.VERSION
    });
  }
}

/** Called by the private Apps Script UI; Google identity protects the UI. */
function uiHealth() {
  return health_();
}

/** Called by the private Apps Script UI; no helper secret is exposed to the browser. */
function uiBuildWatchedMoviesV2() {
  return {
    ok: false,
    retired: true,
    action: 'build_watched_movies_v2',
    helperVersion: NW.VERSION,
    error: 'Watched Movies v2 was retired. Governed runtime views are rebuilt from View Builder Rules by MNT016.'
  };
}

/** Runs the same governed dispatcher used by external callers. */
function uiRunFullMaintenance() {
  const suffix = Utilities.formatDate(new Date(), NW.TIMEZONE, 'yyyyMMdd-HHmmss');
  return runMaintenance_({
    action: 'maintenance',
    mode: 'full',
    operationId: 'UI-MAINT-FULL-' + suffix,
    idempotencyKey: 'UI-MAINT-FULL-' + suffix,
    source: 'Private Apps Script UI'
  });
}

/** Runs a standalone observation-only dynamic refresh. */
function uiRunDynamicRefresh() {
  const suffix = Utilities.formatDate(
    new Date(),
    NW.TIMEZONE,
    'yyyyMMdd-HHmmss'
  );

  const result = runMaintenance_({
    action: 'maintenance',
    mode: 'dynamic_refresh',
    scope: 'all',
    dryRun: true,
    offset: 0,
    limit: 100,
    operationId: 'UI-DYNAMIC-' + suffix,
    idempotencyKey: 'UI-DYNAMIC-' + suffix,
    source: 'Private Apps Script UI'
  });

  console.log(JSON.stringify(result, null, 2));
  return result;
}

function route_(body) {
  const action = String(body.action || '').trim();
  if (action === 'health') return health_();
  if (action === 'install_daily_trigger') return installDailyMaintenanceTrigger_(body);
  if (action === 'remove_daily_trigger') return removeDailyMaintenanceTrigger_(body);
  if (action === 'verify_latest_daily_run') return verifyLatestDailyRun_(body);
  if (action === 'maintenance') return runMaintenance_(body);
  if (action === 'build_watched_movies_v2') {
    throw new Error('Retired action: build_watched_movies_v2. Use governed runtime rebuild (MNT016).');
  }
  if (action === 'collect_dynamic_observations') return collectDynamicObservations_(body);
  if (action === 'collect_dynamic_observations_full_batch') return collectDynamicObservationsFullBatch_(body);
  if (action === 'resolve_dynamic_observations') return resolveDynamicObservations_(body);
  if (action === 'run_dynamic_maintenance_dry_run') return runDynamicMaintenanceDryRun_(body);
  if (action === 'commit_dynamic_resolutions') return commitDynamicResolutions_(body);
  if (action === 'rebuild_dynamic_runtime_views') return rebuildDynamicRuntimeViews_(body);
  if (action === 'finalize_dynamic_refresh_cycle') return finalizeDynamicRefreshCycle_(body);
  if (action === 'refresh_streaming_services') return collectDynamicObservations_(body);
  throw new Error('Unsupported action: ' + action);
}


/**
 * Dry-run dynamic maintenance orchestrator.
 *
 * Runs the certified MNT013 and MNT014 implementations with one shared Cycle ID,
 * then stops before canonical commit, runtime rebuild, or publication.
 */
function runDynamicMaintenanceDryRun_(request) {
  const operationId = requireText_(request.operationId, 'operationId');
  const idempotencyKey = requireText_(request.idempotencyKey, 'idempotencyKey');
  const prior = readIdempotency_(idempotencyKey);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const started = new Date();
  const cycleId = String(request.cycleId || '').trim() || ('CYC-DYNAMIC-' +
    Utilities.formatDate(started, NW.TIMEZONE, 'yyyyMMdd-HHmmss') +
    '-' + Utilities.getUuid().slice(0, 8));
  const source = request.source || 'Dynamic maintenance dry-run orchestrator';
  const scope = request.scope || 'all';
  const offset = request.offset || 0;
  const limit = request.limit || 100;
  const childObservationKey = idempotencyKey + ':MNT013';
  const childResolutionKey = idempotencyKey + ':MNT014';
  let ss = null;
  let repository = null;
  let observationResult = null;
  let resolutionResult = null;

  function finish_(ok, failedStage, error) {
    const completed = new Date();
    const result = {
      ok: ok,
      action: 'run_dynamic_maintenance_dry_run',
      helperVersion: NW.VERSION,
      repository: repository,
      cycleId: cycleId,
      operationId: operationId,
      idempotencyKey: idempotencyKey,
      dryRun: true,
      commitApplied: false,
      runtimeRebuildApplied: false,
      observationSummary: observationResult ? {
        ok: !!observationResult.ok,
        maintenanceTask: observationResult.maintenanceTask,
        cycleId: observationResult.cycleId,
        observationsRecorded: observationResult.observationsRecorded,
        expectedPopulation: observationResult.expectedPopulation,
        processed: observationResult.processed,
        observed: observationResult.observed,
        outstanding: observationResult.outstanding,
        remaining: observationResult.remaining,
        replayed: !!observationResult.replayed
      } : null,
      resolutionSummary: resolutionResult ? {
        ok: !!resolutionResult.ok,
        maintenanceTask: resolutionResult.maintenanceTask,
        sourceCycleId: resolutionResult.sourceCycleId,
        observationsRead: resolutionResult.observationsRead,
        resolutionsRecorded: resolutionResult.resolutionsRecorded,
        classifications: resolutionResult.classifications,
        replayed: !!resolutionResult.replayed
      } : null,
      expectedPopulation: resolutionResult ? resolutionResult.expectedPopulation :
        (observationResult ? observationResult.expectedPopulation : null),
      reconciledPopulation: resolutionResult ? resolutionResult.reconciledPopulation : 0,
      unaccounted: resolutionResult ? resolutionResult.unaccounted :
        (observationResult ? observationResult.expectedPopulation : null),
      coveragePercent: resolutionResult ? resolutionResult.coveragePercent : 0,
      cycleStatus: resolutionResult ? resolutionResult.cycleStatus :
        (observationResult ? 'Observed — Partial' : 'Not Started'),
      failedStage: failedStage || null,
      error: error || '',
      startedAt: formatDate_(started),
      completedAt: formatDate_(completed),
      durationSeconds: Math.round((completed.getTime() - started.getTime()) / 1000),
      replayed: false
    };
    storeIdempotency_(idempotencyKey, result);
    return result;
  }

  try {
    console.log('[DRY-RUN] Stage: repository verification');
    ss = openRepository_();
    repository = verifyRepository_(ss);
  } catch (err) {
    return finish_(false, 'repository_verification', String(err && err.message ? err.message : err));
  }

  console.log('[DRY-RUN] Stage: cycle creation | ' + cycleId);

  try {
    console.log('[DRY-RUN] Stage: observation collection | ' + cycleId);
    observationResult = collectDynamicObservations_({
      action: 'collect_dynamic_observations',
      operationId: operationId + ':MNT013',
      idempotencyKey: childObservationKey,
      cycleId: cycleId,
      source: source,
      scope: scope,
      dryRun: true,
      offset: offset,
      limit: limit
    });
    if (!observationResult || !observationResult.ok) {
      throw new Error('MNT013 returned ok=false');
    }
    if (String(observationResult.cycleId) !== cycleId) {
      throw new Error('MNT013 returned a different Cycle ID: ' + observationResult.cycleId);
    }
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    try {
      appendAudit_(ss, 'Dynamic maintenance dry run failed', 'Dynamic Refresh', cycleId,
        'Actor: Next Watch Helper | Operation ID: ' + operationId +
        ' | Idempotency Key: ' + idempotencyKey +
        ' | Failed stage: observation_collection | Error: ' + message +
        ' | Canonical commit: False | Runtime rebuild: False');
    } catch (ignored) {}
    return finish_(false, 'observation_collection', message);
  }

  try {
    console.log('[DRY-RUN] Stage: resolution | ' + cycleId);
    resolutionResult = resolveDynamicObservations_({
      action: 'resolve_dynamic_observations',
      operationId: operationId + ':MNT014',
      idempotencyKey: childResolutionKey,
      sourceCycleId: cycleId,
      policyId: request.policyId || 'DRP003',
      source: source
    });
    if (!resolutionResult || !resolutionResult.ok) {
      throw new Error('MNT014 returned ok=false');
    }
    if (String(resolutionResult.sourceCycleId) !== cycleId) {
      throw new Error('MNT014 resolved a different Cycle ID: ' + resolutionResult.sourceCycleId);
    }
    if (resolutionResult.commitApplied || !resolutionResult.resolutionOnly) {
      throw new Error('MNT014 violated the resolution-only contract');
    }
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    try {
      appendAudit_(ss, 'Dynamic maintenance dry run failed', 'Dynamic Refresh', cycleId,
        'Actor: Next Watch Helper | Operation ID: ' + operationId +
        ' | Idempotency Key: ' + idempotencyKey +
        ' | Failed stage: resolution | Error: ' + message +
        ' | Observations preserved: True | Canonical commit: False | Runtime rebuild: False');
    } catch (ignored) {}
    return finish_(false, 'resolution', message);
  }

  console.log('[DRY-RUN] Stage: dry-run completion | ' + cycleId);
  const result = finish_(true, null, '');
  appendAudit_(ss, 'Dynamic maintenance dry run completed', 'Dynamic Refresh', cycleId,
    'Actor: Next Watch Helper | Operation ID: ' + operationId +
    ' | Idempotency Key: ' + idempotencyKey +
    ' | Observations: ' + result.observationSummary.observationsRecorded +
    ' | Resolutions: ' + result.resolutionSummary.resolutionsRecorded +
    ' | Coverage %: ' + result.coveragePercent +
    ' | Status: ' + result.cycleStatus +
    ' | Canonical commit: False | Runtime rebuild: False');
  return result;
}

/**
 * Stable maintenance dispatcher.
 *
 * Modes:
 *   full            - run the governed MNT013-MNT017 lifecycle.
 *   dynamic_refresh - run only standalone dynamic observations.
 *
 * This wrapper is idempotent. Child operations receive deterministic child keys,
 * so retries cannot duplicate completed governed maintenance steps.
 */
function runMaintenance_(request) {
  const mode = String(request.mode || 'full').trim().toLowerCase();
  if (['full', 'dynamic_refresh', 'verify_only'].indexOf(mode) < 0) {
    throw new Error('Unsupported maintenance mode: ' + mode);
  }

  const operationId = requireText_(request.operationId, 'operationId');
  const idempotencyKey = requireText_(request.idempotencyKey, 'idempotencyKey');
  const prior = readIdempotency_(idempotencyKey);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const lease = acquireMaintenanceLease_(operationId, idempotencyKey);
  const started = new Date();
  const steps = [];
  let ss = null;
  let repository = null;
  let cycleId = String(request.cycleId || '').trim();

  function executeStep_(name, fn) {
    const step = runMaintenanceStep_(name, fn);
    steps.push(step);
    if (!step.ok) throw new Error(name + ' failed: ' + (step.error || 'returned ok=false'));
    return step.result;
  }

  try {
    ss = openRepository_();
    repository = verifyRepository_(ss);

    if (mode === 'verify_only') {
      const verification = verifyLatestDailyRun_({dateKey: request.dateKey || dailyDateKey_(started)});
      const result = maintenanceResult_(true, mode, operationId, idempotencyKey, repository, steps,
        verification.cycleId || '', started, null, verification);
      storeIdempotency_(idempotencyKey, result);
      return result;
    }

    if (!cycleId) {
      cycleId = 'CYC-DYNAMIC-DAILY-' + dailyDateKey_(started) + '-' + Utilities.getUuid().slice(0, 8);
    }

    const source = request.source || 'Next Watch Helper scheduled maintenance';
    const scope = request.scope || 'all';
    const batchSize = Math.max(1, Math.min(Number(request.batchSize || NW.DEFAULT_BATCH_SIZE), 50));
    let batchNumber = 0;
    let observationResult = null;

    do {
      batchNumber++;
      observationResult = executeStep_('MNT013-B' + pad2_(batchNumber), function() {
        return collectDynamicObservationsFullBatch_({
          action: 'collect_dynamic_observations_full_batch',
          cycleId: cycleId,
          cycleIdempotencyKey: idempotencyKey + ':CYCLE',
          operationId: operationId + ':MNT013:B' + pad2_(batchNumber),
          idempotencyKey: idempotencyKey + ':MNT013:B' + pad2_(batchNumber),
          source: source,
          scope: scope,
          batchSize: batchSize
        });
      });
      refreshMaintenanceLease_(lease);
      if (batchNumber > 100) throw new Error('MNT013 exceeded safe batch limit');
    } while (Number(observationResult.remaining || 0) > 0);

    executeStep_('MNT014', function() {
      return resolveDynamicObservations_({
        action: 'resolve_dynamic_observations',
        sourceCycleId: cycleId,
        policyId: request.policyId || 'DRP003',
        operationId: operationId + ':MNT014',
        idempotencyKey: idempotencyKey + ':MNT014',
        source: source
      });
    });

    executeStep_('MNT015', function() {
      return commitDynamicResolutions_({
        action: 'commit_dynamic_resolutions',
        sourceCycleId: cycleId,
        operationId: operationId + ':MNT015',
        idempotencyKey: idempotencyKey + ':MNT015',
        source: source
      });
    });

    executeStep_('MNT016', function() {
      return rebuildDynamicRuntimeViews_({
        action: 'rebuild_dynamic_runtime_views',
        sourceCycleId: cycleId,
        operationId: operationId + ':MNT016',
        idempotencyKey: idempotencyKey + ':MNT016',
        source: source
      });
    });

    const reconciliation = executeStep_('MNT017', function() {
      return finalizeDynamicRefreshCycle_({
        action: 'finalize_dynamic_refresh_cycle',
        sourceCycleId: cycleId,
        operationId: operationId + ':MNT017',
        idempotencyKey: idempotencyKey + ':MNT017',
        source: source
      });
    });

    if (Number(reconciliation.unaccounted || 0) !== 0 || Number(reconciliation.coveragePercent || 0) < 100) {
      throw new Error('Reconciliation failed: unaccounted=' + reconciliation.unaccounted +
        ', coverage=' + reconciliation.coveragePercent);
    }

    const verification = verifyCycleCompletion_(ss, cycleId);
    if (!verification.ok) throw new Error('Post-run verification failed: ' + verification.errors.join(' | '));

    const result = maintenanceResult_(true, mode, operationId, idempotencyKey, repository, steps,
      cycleId, started, null, verification);
    appendAudit_(ss, 'Governed daily maintenance completed', 'Maintenance', cycleId,
      'Actor: Next Watch Helper | Operation ID: ' + operationId +
      ' | Idempotency Key: ' + idempotencyKey +
      ' | Steps: ' + steps.map(function(x){return x.name + '=' + x.ok;}).join(', ') +
      ' | Coverage: ' + verification.coveragePercent +
      ' | Unaccounted: ' + verification.unaccounted +
      ' | Final status: ' + verification.status + ' | Success: True');
    upsertMaintenanceWorkLog_(ss, result, 'Completed');
    storeIdempotency_(idempotencyKey, result);
    return result;
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    const failure = maintenanceResult_(false, mode, operationId, idempotencyKey, repository, steps,
      cycleId, started, message, null);
    if (ss) {
      try { markCycleAttentionRequired_(ss, cycleId, operationId, message); } catch (ignored) {}
      try {
        appendAudit_(ss, 'Governed daily maintenance failed', 'Maintenance', cycleId || mode,
          'Actor: Next Watch Helper | Operation ID: ' + operationId +
          ' | Idempotency Key: ' + idempotencyKey +
          ' | Error: ' + message +
          ' | Last verified state preserved: True | Success: False');
      } catch (ignored3) {}
      try { upsertMaintenanceWorkLog_(ss, failure, 'Attention Required'); } catch (ignored4) {}
    }
    storeIdempotency_(idempotencyKey, failure);
    return failure;
  } finally {
    releaseMaintenanceLease_(lease);
  }
}


/** Production time-driven trigger entry point. */
function runDailyMaintenance() {
  maintainIdempotencyStorage_({reason: 'daily_maintenance_start'});
  const now = new Date();
  const dateKey = dailyDateKey_(now);
  const key = 'NEXT-WATCH-DAILY-' + dateKey;
  const prior = readIdempotency_(key);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const state = readMaintenanceState_();
  if (state && state.idempotencyKey !== key && !maintenanceStateExpired_(state)) {
    throw new Error('A prior daily maintenance state is still active: ' + state.operationId);
  }
  if (!state || state.idempotencyKey !== key) {
    writeMaintenanceState_({
      schemaVersion: 1,
      operationId: 'DAILY-MAINT-' + dateKey,
      idempotencyKey: key,
      cycleId: 'CYC-DYNAMIC-DAILY-' + dateKey + '-' + Utilities.getUuid().slice(0, 8),
      phase: 'MNT013',
      batchNumber: 0,
      source: 'Apps Script time-driven trigger',
      scope: 'all',
      batchSize: NW.DEFAULT_BATCH_SIZE,
      startedAt: formatDate_(now),
      startedAtMs: now.getTime(),
      updatedAtMs: now.getTime(),
      steps: []
    });
  }
  return continueDailyMaintenance();
}

/** Resumes exactly one bounded lifecycle unit and schedules the next unit. */
function continueDailyMaintenance() {
  const leaseState = readMaintenanceState_();
  if (!leaseState) return {ok: true, status: 'No active maintenance state'};
  const state = leaseState;
  const lease = acquireMaintenanceLease_(state.operationId, state.idempotencyKey + ':' + state.phase);
  let ss = null;
  try {
    ss = openRepository_();
    const repository = verifyRepository_(ss);
    let result;

    if (state.phase === 'MNT013') {
      state.batchNumber++;
      result = collectDynamicObservationsFullBatch_({
        action: 'collect_dynamic_observations_full_batch', cycleId: state.cycleId,
        cycleIdempotencyKey: state.idempotencyKey + ':CYCLE',
        operationId: state.operationId + ':MNT013:B' + pad2_(state.batchNumber),
        idempotencyKey: state.idempotencyKey + ':MNT013:B' + pad2_(state.batchNumber),
        source: state.source, scope: state.scope, batchSize: state.batchSize
      });
      recordStateStep_(state, 'MNT013-B' + pad2_(state.batchNumber), result);
      state.phase = Number(result.remaining || 0) > 0 ? 'MNT013' : 'MNT014';
    } else if (state.phase === 'MNT014') {
      result = resolveDynamicObservations_({sourceCycleId: state.cycleId, policyId: 'DRP003',
        operationId: state.operationId + ':MNT014', idempotencyKey: state.idempotencyKey + ':MNT014', source: state.source});
      recordStateStep_(state, 'MNT014', result); state.phase = 'MNT015';
    } else if (state.phase === 'MNT015') {
      result = commitDynamicResolutions_({sourceCycleId: state.cycleId,
        operationId: state.operationId + ':MNT015', idempotencyKey: state.idempotencyKey + ':MNT015', source: state.source});
      recordStateStep_(state, 'MNT015', result); state.phase = 'MNT016';
    } else if (state.phase === 'MNT016') {
      result = rebuildDynamicRuntimeViews_({sourceCycleId: state.cycleId,
        operationId: state.operationId + ':MNT016', idempotencyKey: state.idempotencyKey + ':MNT016', source: state.source});
      recordStateStep_(state, 'MNT016', result); state.phase = 'MNT017';
    } else if (state.phase === 'MNT017') {
      result = finalizeDynamicRefreshCycle_({sourceCycleId: state.cycleId,
        operationId: state.operationId + ':MNT017', idempotencyKey: state.idempotencyKey + ':MNT017', source: state.source});
      recordStateStep_(state, 'MNT017', result);
      if (Number(result.unaccounted || 0) !== 0 || Number(result.coveragePercent || 0) < 100) {
        throw new Error('Reconciliation incomplete: coverage=' + result.coveragePercent + ', unaccounted=' + result.unaccounted);
      }
      state.phase = 'VERIFY';
    } else if (state.phase === 'MNT012') {
      // Migration guard for checkpoints created by helper versions <= 2.1.0.
      // The retired special-case build is skipped rather than recreated.
      result = {ok: true, retired: true, maintenanceTask: 'MNT012',
        status: 'Skipped — retired Watched Movies v2 special case'};
      recordStateStep_(state, 'MNT012-RETIRED', result); state.phase = 'VERIFY';
    } else if (state.phase === 'VERIFY') {
      const verification = verifyCycleCompletion_(ss, state.cycleId);
      if (!verification.ok) throw new Error('Post-run verification failed: ' + verification.errors.join(' | '));
      const completed = maintenanceResult_(true, 'full', state.operationId, state.idempotencyKey,
        repository, state.steps, state.cycleId, new Date(state.startedAtMs), null, verification);
      appendAudit_(ss, 'Governed daily maintenance completed', 'Maintenance', state.cycleId,
        'Actor: Next Watch Helper | Operation ID: ' + state.operationId +
        ' | Idempotency Key: ' + state.idempotencyKey +
        ' | Coverage: ' + verification.coveragePercent + ' | Unaccounted: ' + verification.unaccounted +
        ' | Final status: ' + verification.status + ' | Success: True');
      upsertMaintenanceWorkLog_(ss, completed, 'Completed');
      storeIdempotency_(state.idempotencyKey, completed);
      clearMaintenanceState_();
      removeContinuationTriggers_();
      return completed;
    } else {
      throw new Error('Unsupported persisted maintenance phase: ' + state.phase);
    }

    // Any successful bounded lifecycle unit clears the consecutive transient retry counter.
    clearTransientRetryState_(state);
    state.updatedAtMs = new Date().getTime();
    writeMaintenanceState_(state);
    scheduleMaintenanceContinuation_();
    return {ok: true, action: 'continue_daily_maintenance', phaseCompleted: state.steps[state.steps.length - 1].name,
      nextPhase: state.phase, cycleId: state.cycleId, helperVersion: NW.VERSION};
  } catch (err) {
    let message = String(err && err.message ? err.message : err);

    // Infrastructure timeouts are recoverable. Preserve the exact checkpoint and
    // schedule a bounded retry rather than converting a transient Google outage
    // into an operator-required repository failure. No canonical state is rolled
    // forward by this branch.
    if (isTransientGoogleServiceError_(message)) {
      const retry = registerTransientRetry_(state, message);
      if (retry.retryScheduled) {
        state.status = 'Transient Retry Scheduled';
        state.error = message;
        state.updatedAtMs = new Date().getTime();
        writeMaintenanceState_(state);

        if (ss) {
          try {
            appendAudit_(ss, 'Transient maintenance retry scheduled', 'Maintenance', state.cycleId,
              'Actor: Next Watch Helper | Phase: ' + state.phase +
              ' | Attempt: ' + retry.attempt + '/' + NW.TRANSIENT_RETRY_MAX_ATTEMPTS +
              ' | Retry delay seconds: ' + Math.round(retry.delayMs / 1000) +
              ' | Error: ' + message +
              ' | Checkpoint preserved: True | Canonical commit from failed unit: False');
          } catch (ignoredTransientAudit) {}
        }

        try {
          scheduleMaintenanceContinuation_(retry.delayMs);
          return {
            ok: true,
            action: 'continue_daily_maintenance',
            status: 'Transient Retry Scheduled',
            cycleId: state.cycleId,
            phase: state.phase,
            retryAttempt: retry.attempt,
            retryDelaySeconds: Math.round(retry.delayMs / 1000),
            error: message,
            helperVersion: NW.VERSION
          };
        } catch (scheduleErr) {
          // If Apps Script cannot create the retry trigger, fall through to the
          // normal Attention Required path so the failure is never hidden.
          message = message + ' | Retry scheduling failed: ' +
            String(scheduleErr && scheduleErr.message ? scheduleErr.message : scheduleErr);
        }
      } else {
        message = message + ' | Automatic transient retry limit exhausted (' +
          NW.TRANSIENT_RETRY_MAX_ATTEMPTS + ' attempts).';
      }
    }

    if (ss) {
      try { markCycleAttentionRequired_(ss, state.cycleId, state.operationId, message); } catch (ignored) {}
      try {
        const failure = maintenanceResult_(false, 'full', state.operationId, state.idempotencyKey,
          null, state.steps || [], state.cycleId, new Date(state.startedAtMs), message, null);
        appendAudit_(ss, 'Governed daily maintenance failed', 'Maintenance', state.cycleId,
          'Actor: Next Watch Helper | Phase: ' + state.phase + ' | Error: ' + message +
          ' | Last verified state preserved: True | Success: False');
      } catch (ignored2) {}
      try {
        const failure = maintenanceResult_(false, 'full', state.operationId, state.idempotencyKey,
          null, state.steps || [], state.cycleId, new Date(state.startedAtMs), message, null);
        upsertMaintenanceWorkLog_(ss, failure, 'Attention Required');
      } catch (ignored3) {}
    }
    state.error = message; state.status = 'Attention Required'; state.updatedAtMs = new Date().getTime();
    writeMaintenanceState_(state);
    removeContinuationTriggers_();
    return {ok: false, cycleId: state.cycleId, phase: state.phase, error: message, helperVersion: NW.VERSION};
  } finally {
    releaseMaintenanceLease_(lease);
  }
}

function recordStateStep_(state, name, result) {
  if (!result || result.ok === false) throw new Error(name + ' returned ok=false');
  state.steps.push({name: name, ok: true, completedAt: now_(), result: summarizeStepResult_(result)});
}

function summarizeStepResult_(result) {
  result = result || {};
  const summary = {
    maintenanceTask: result.maintenanceTask || '',
    cycleId: result.cycleId || result.sourceCycleId || '',
    status: result.finalStatus || result.cycleStatus || ''
  };
  [
    'expectedPopulation','processed','observed','outstanding','outstandingVerification',
    'expectedNoProvider','providerVerificationPending','identityResolutionRequired',
    'remaining','observationsRead','resolutionsRead','recordsCommitted','changed',
    'reverified','unchangedCurrent','viewsRebuilt','runtimeViewsVerified',
    'runtimeRowsUpdated','coveragePercent','unaccounted'
  ].forEach(function(key) {
    if (result[key] !== undefined && result[key] !== null && result[key] !== '') {
      summary[key] = result[key];
    }
  });
  return summary;
}

function scheduleMaintenanceContinuation_(delayMs) {
  const cleanup = removeContinuationTriggers_({silent: true});
  if (!cleanup.ok) {
    throw new Error('Unable to inspect continuation triggers: ' + cleanup.error);
  }
  const delay = Math.max(60 * 1000, Number(delayMs || 60 * 1000));
  ScriptApp.newTrigger('continueDailyMaintenance').timeBased().after(delay).create();
}

/**
 * Classifies only known transient Google infrastructure failures. Repository
 * contract errors, validation failures, authorization failures, TMDb failures,
 * and application bugs intentionally remain hard failures.
 */
function isTransientGoogleServiceError_(message) {
  const text = String(message || '').trim();
  if (!text) return false;
  return [
    /Service (Drive|Spreadsheets) timed out/i,
    /Service (Drive|Spreadsheets) is unavailable/i,
    /Service unavailable.*(Drive|Spreadsheets)/i,
    /Internal error.*(Drive|Spreadsheets)/i,
    /Backend Error.*(Drive|Spreadsheets)/i,
    /Temporary.*(Drive|Spreadsheets).*error/i
  ].some(function(pattern) { return pattern.test(text); });
}

function transientRetryDelayMs_(attempt) {
  const delays = NW.TRANSIENT_RETRY_DELAYS_MS || [60 * 1000, 3 * 60 * 1000, 10 * 60 * 1000];
  const index = Math.max(0, Math.min(Number(attempt || 1) - 1, delays.length - 1));
  return Number(delays[index]);
}

function registerTransientRetry_(state, message) {
  const phase = String(state.phase || '');
  const prior = state.transientRetry || {};
  const samePhase = String(prior.phase || '') === phase;
  const attempt = (samePhase ? Number(prior.attempt || 0) : 0) + 1;
  const retryScheduled = attempt <= Number(NW.TRANSIENT_RETRY_MAX_ATTEMPTS || 3);
  state.transientRetry = {
    phase: phase,
    attempt: attempt,
    lastError: String(message || ''),
    lastFailureAt: now_(),
    retryScheduled: retryScheduled
  };
  return {
    attempt: attempt,
    retryScheduled: retryScheduled,
    delayMs: transientRetryDelayMs_(attempt)
  };
}

function clearTransientRetryState_(state) {
  if (state && state.transientRetry) delete state.transientRetry;
}

/** Pure regression test; it creates no triggers and performs no repository writes. */
function testTransientGoogleRetryPolicyV222() {
  const transientSamples = [
    'Service Drive timed out while accessing document with id TEST.',
    'Service Spreadsheets timed out while accessing document with id TEST.',
    'Service Drive is unavailable.'
  ];
  const hardFailureSamples = [
    'Repository title mismatch: Wrong Repository',
    'TMDb HTTP 401: Unauthorized',
    'Refresh Cycles header contract mismatch',
    'Missing Script Property: TMDB_BEARER_TOKEN'
  ];
  transientSamples.forEach(function(sample) {
    if (!isTransientGoogleServiceError_(sample)) throw new Error('Transient sample not recognized: ' + sample);
  });
  hardFailureSamples.forEach(function(sample) {
    if (isTransientGoogleServiceError_(sample)) throw new Error('Hard failure misclassified as transient: ' + sample);
  });
  const state = {phase: 'MNT013'};
  const r1 = registerTransientRetry_(state, transientSamples[0]);
  const r2 = registerTransientRetry_(state, transientSamples[0]);
  const r3 = registerTransientRetry_(state, transientSamples[0]);
  const r4 = registerTransientRetry_(state, transientSamples[0]);
  if (!r1.retryScheduled || !r2.retryScheduled || !r3.retryScheduled || r4.retryScheduled) {
    throw new Error('Retry-bound contract failed');
  }
  if (!(r1.delayMs < r2.delayMs && r2.delayMs < r3.delayMs)) {
    throw new Error('Retry backoff contract failed');
  }
  clearTransientRetryState_(state);
  if (state.transientRetry) throw new Error('Transient retry state did not clear');
  return {
    ok: true,
    helperVersion: NW.VERSION,
    maxAttempts: NW.TRANSIENT_RETRY_MAX_ATTEMPTS,
    delaysSeconds: NW.TRANSIENT_RETRY_DELAYS_MS.map(function(x) { return Math.round(x / 1000); }),
    transientSamplesVerified: transientSamples.length,
    hardFailureSamplesVerified: hardFailureSamples.length,
    message: 'PASS — transient Google Drive/Sheets failures are bounded-retryable; application and repository failures remain hard failures.'
  };
}

/**
 * Removes continuation triggers without ever masking the primary maintenance
 * result. Callers may inspect ok/error and decide whether trigger access is
 * required for their operation.
 */
function removeContinuationTriggers_(request) {
  request = request || {};
  let removed = 0;
  try {
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'continueDailyMaintenance') {
        ScriptApp.deleteTrigger(t);
        removed++;
      }
    });
    return {ok: true, removed: removed};
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (!request.silent) console.warn('Continuation-trigger cleanup failed: ' + message);
    return {ok: false, removed: removed, error: message};
  }
}

/**
 * Explicit authorization probe. Run once from the Apps Script editor after
 * adding the script.scriptapp OAuth scope. Google will display the consent
 * dialog when authorization is required.
 */
function authorizeTriggerPermissions() {
  const triggers = ScriptApp.getProjectTriggers();
  return {
    ok: true,
    helperVersion: NW.VERSION,
    projectTriggerCount: triggers.length,
    handlers: triggers.map(function(t) { return t.getHandlerFunction(); })
  };
}
function readMaintenanceState_() {
  const raw = PropertiesService.getScriptProperties().getProperty('NW_DAILY_MAINTENANCE_STATE');
  return raw ? JSON.parse(raw) : null;
}
function writeMaintenanceState_(state) {
  PropertiesService.getScriptProperties().setProperty('NW_DAILY_MAINTENANCE_STATE', JSON.stringify(state));
}
function clearMaintenanceState_() {
  PropertiesService.getScriptProperties().deleteProperty('NW_DAILY_MAINTENANCE_STATE');
}

/** Returns the current maintenance lease without exposing its private token. */
function readMaintenanceLeaseSummary_() {
  const raw = PropertiesService.getScriptProperties().getProperty('NW_MAINTENANCE_LEASE');
  if (!raw) return null;
  let lease;
  try {
    lease = JSON.parse(raw);
  } catch (err) {
    return {malformed: true, expired: false, error: 'NW_MAINTENANCE_LEASE is malformed'};
  }
  const nowMs = new Date().getTime();
  const expiresAt = Number(lease.expiresAt || 0);
  return {
    malformed: false,
    operationId: String(lease.operationId || ''),
    idempotencyKey: String(lease.idempotencyKey || ''),
    expiresAt: expiresAt,
    expired: !expiresAt || expiresAt <= nowMs
  };
}

/** Finds compact idempotency receipts belonging to one logical root request. */
function idempotencyReceiptPropertiesForRoot_(rootKey) {
  rootKey = String(rootKey || '');
  if (!rootKey) return [];
  const properties = PropertiesService.getScriptProperties().getProperties();
  const matches = [];
  Object.keys(properties).forEach(function(propertyName) {
    if (propertyName.indexOf('IDEMPOTENCY_') !== 0) return;
    try {
      const receipt = JSON.parse(String(properties[propertyName] || ''));
      const receiptKey = String(receipt.idempotencyKey || '');
      if (idempotencyKeyBelongsToRoot_(receiptKey, rootKey)) {
        matches.push({propertyName: propertyName, idempotencyKey: receiptKey});
      }
    } catch (ignored) {}
  });
  return matches;
}

function clearIdempotencyReceiptsForRoot_(rootKey) {
  const matches = idempotencyReceiptPropertiesForRoot_(rootKey);
  const store = PropertiesService.getScriptProperties();
  matches.forEach(function(entry) { store.deleteProperty(entry.propertyName); });
  return matches;
}

/**
 * Read-only operator diagnostic for daily-maintenance orchestration state.
 * It intentionally reports property names/counts and lease metadata, never secret values.
 */
function showMaintenanceState() {
  const now = new Date();
  const dateKey = dailyDateKey_(now);
  const dailyKey = 'NEXT-WATCH-DAILY-' + dateKey;
  const state = readMaintenanceState_();
  const lease = readMaintenanceLeaseSummary_();
  const receipts = idempotencyReceiptPropertiesForRoot_(dailyKey);
  return {
    ok: true,
    helperVersion: NW.VERSION,
    dateKey: dateKey,
    dailyIdempotencyKey: dailyKey,
    dailyReceiptCount: receipts.length,
    dailyReceiptKeys: receipts.map(function(x) { return x.idempotencyKey; }),
    activeState: !!state,
    maintenanceState: state ? {
      operationId: state.operationId || '',
      idempotencyKey: state.idempotencyKey || '',
      cycleId: state.cycleId || '',
      phase: state.phase || '',
      batchNumber: numberOrZero_(state.batchNumber),
      status: state.status || '',
      retryAttempt: state.transientRetry ? numberOrZero_(state.transientRetry.attempt) : 0,
      updatedAtMs: numberOrZero_(state.updatedAtMs),
      expired: maintenanceStateExpired_(state)
    } : null,
    lease: lease
  };
}

/** Clears only an expired maintenance lease; an active or malformed lease is preserved. */
function clearStaleMaintenanceLease() {
  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);
  try {
    const store = PropertiesService.getScriptProperties();
    const raw = store.getProperty('NW_MAINTENANCE_LEASE');
    if (!raw) return {ok: true, helperVersion: NW.VERSION, cleared: false, reason: 'No maintenance lease present'};
    let lease;
    try { lease = JSON.parse(raw); }
    catch (err) {
      throw new Error('Maintenance lease is malformed; refusing automatic deletion');
    }
    const expiresAt = Number(lease.expiresAt || 0);
    if (expiresAt && expiresAt > new Date().getTime()) {
      return {ok: true, helperVersion: NW.VERSION, cleared: false, reason: 'Lease is still active',
        operationId: String(lease.operationId || ''), expiresAt: expiresAt};
    }
    store.deleteProperty('NW_MAINTENANCE_LEASE');
    return {ok: true, helperVersion: NW.VERSION, cleared: true, reason: 'Expired maintenance lease removed',
      operationId: String(lease.operationId || '')};
  } finally {
    lock.releaseLock();
  }
}

/**
 * Developer-only daily rerun reset. By default it refuses to disturb an active
 * maintenance checkpoint or live lease. It removes today's root AND child
 * idempotency receipts, the persisted checkpoint, stale/forced lease, and
 * continuation triggers. Repository sheets and the permanent daily trigger are untouched.
 */
function resetDailyMaintenanceForTesting(force) {
  const forceReset = force === true;
  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);
  try {
    const now = new Date();
    const dateKey = dailyDateKey_(now);
    const dailyKey = 'NEXT-WATCH-DAILY-' + dateKey;
    const state = readMaintenanceState_();
    const lease = readMaintenanceLeaseSummary_();

    if (state && !maintenanceStateExpired_(state) && !forceReset) {
      throw new Error('Active maintenance state exists for ' + String(state.operationId || 'unknown') +
        '. Refusing reset. Use forceResetDailyMaintenanceForTesting() only if you intentionally want to abandon it.');
    }
    if (lease && (lease.malformed || !lease.expired) && !forceReset) {
      throw new Error(lease.malformed
        ? 'Maintenance lease is malformed; refusing reset without explicit force'
        : 'Active maintenance lease exists for ' + String(lease.operationId || 'unknown') +
          '. Refusing reset. Use forceResetDailyMaintenanceForTesting() only if you intentionally want to abandon it.');
    }

    const triggerCleanup = removeContinuationTriggers_({silent: true});
    if (!triggerCleanup.ok) {
      throw new Error('Unable to clear continuation triggers; reset aborted: ' + triggerCleanup.error);
    }

    const removedReceipts = clearIdempotencyReceiptsForRoot_(dailyKey);
    const store = PropertiesService.getScriptProperties();
    const hadState = !!store.getProperty('NW_DAILY_MAINTENANCE_STATE');
    const hadLease = !!store.getProperty('NW_MAINTENANCE_LEASE');
    store.deleteProperty('NW_DAILY_MAINTENANCE_STATE');
    store.deleteProperty('NW_MAINTENANCE_LEASE');

    const result = {
      ok: true,
      helperVersion: NW.VERSION,
      testReset: true,
      force: forceReset,
      dateKey: dateKey,
      dailyIdempotencyKey: dailyKey,
      idempotencyReceiptsRemoved: removedReceipts.length,
      removedReceiptKeys: removedReceipts.map(function(x) { return x.idempotencyKey; }),
      maintenanceStateRemoved: hadState,
      maintenanceLeaseRemoved: hadLease,
      continuationTriggersRemoved: Number(triggerCleanup.removed || 0),
      permanentDailyTriggerTouched: false,
      repositorySheetsTouched: false,
      nextAction: 'Run runDailyMaintenance() once to start a fresh governed daily cycle for testing.'
    };
    console.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Explicit editor-friendly force wrapper; use only to abandon a known active test cycle. */
function forceResetDailyMaintenanceForTesting() {
  return resetDailyMaintenanceForTesting(true);
}

/** Pure developer-tool regression test; performs no property, trigger, or repository writes. */
function testMaintenanceDeveloperToolsV223() {
  const root = 'NEXT-WATCH-DAILY-20991231';
  if (!idempotencyKeyBelongsToRoot_(root, root)) throw new Error('Root idempotency match failed');
  if (!idempotencyKeyBelongsToRoot_(root + ':MNT013:B01', root)) throw new Error('Child idempotency match failed');
  if (!idempotencyKeyBelongsToRoot_(root + ':MNT017', root)) throw new Error('Terminal child idempotency match failed');
  if (idempotencyKeyBelongsToRoot_('NEXT-WATCH-DAILY-20991230:MNT013:B01', root)) {
    throw new Error('Unrelated daily receipt was incorrectly matched');
  }
  return {
    ok: true,
    helperVersion: NW.VERSION,
    message: 'PASS — developer reset receipt scoping is exact and does not match another daily root.'
  };
}

function maintenanceStateExpired_(state) {
  return new Date().getTime() - Number(state.updatedAtMs || 0) > NW.ORCHESTRATION_LEASE_MINUTES * 60000;
}

function installDailyMaintenanceTrigger() {
  return installDailyMaintenanceTrigger_({});
}

function installDailyMaintenanceTrigger_(request) {
  const cleanup = removeDailyMaintenanceTrigger_({silent: true});
  if (!cleanup.ok) {
    throw new Error('Cannot install daily trigger until ScriptApp permission is granted: ' + cleanup.error);
  }
  const trigger = ScriptApp.newTrigger(NW.DAILY_TRIGGER_HANDLER)
    .timeBased()
    .atHour(NW.DAILY_TRIGGER_HOUR)
    .nearMinute(NW.DAILY_TRIGGER_NEAR_MINUTE)
    .everyDays(1)
    .inTimezone(NW.TIMEZONE)
    .create();
  return {ok: true, handler: trigger.getHandlerFunction(), timezone: NW.TIMEZONE,
    hour: NW.DAILY_TRIGGER_HOUR, nearMinute: NW.DAILY_TRIGGER_NEAR_MINUTE};
}

function removeDailyMaintenanceTrigger() {
  return removeDailyMaintenanceTrigger_({});
}

function removeDailyMaintenanceTrigger_(request) {
  request = request || {};
  let removed = 0;
  try {
    ScriptApp.getProjectTriggers().forEach(function(trigger) {
      if (trigger.getHandlerFunction() === NW.DAILY_TRIGGER_HANDLER) {
        ScriptApp.deleteTrigger(trigger);
        removed++;
      }
    });
    return {ok: true, removed: removed, silent: !!request.silent};
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (!request.silent) console.warn('Daily-trigger cleanup failed: ' + message);
    return {ok: false, removed: removed, silent: !!request.silent, error: message};
  }
}

function dailyDateKey_(date) {
  return Utilities.formatDate(date, NW.TIMEZONE, 'yyyyMMdd');
}

function pad2_(n) { return String(n).padStart(2, '0'); }

function acquireMaintenanceLease_(operationId, idempotencyKey) {
  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty('NW_MAINTENANCE_LEASE');
    const nowMs = new Date().getTime();
    if (raw) {
      const prior = JSON.parse(raw);
      if (Number(prior.expiresAt || 0) > nowMs && prior.idempotencyKey !== idempotencyKey) {
        throw new Error('Another maintenance run is active: ' + prior.operationId);
      }
    }
    const lease = {token: Utilities.getUuid(), operationId: operationId, idempotencyKey: idempotencyKey,
      expiresAt: nowMs + NW.ORCHESTRATION_LEASE_MINUTES * 60000};
    props.setProperty('NW_MAINTENANCE_LEASE', JSON.stringify(lease));
    return lease;
  } finally { lock.releaseLock(); }
}

function refreshMaintenanceLease_(lease) {
  lease.expiresAt = new Date().getTime() + NW.ORCHESTRATION_LEASE_MINUTES * 60000;
  PropertiesService.getScriptProperties().setProperty('NW_MAINTENANCE_LEASE', JSON.stringify(lease));
}

function releaseMaintenanceLease_(lease) {
  if (!lease) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);
  try {
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty('NW_MAINTENANCE_LEASE');
    if (raw && JSON.parse(raw).token === lease.token) props.deleteProperty('NW_MAINTENANCE_LEASE');
  } finally { lock.releaseLock(); }
}

function maintenanceResult_(ok, mode, operationId, idempotencyKey, repository, steps, cycleId, started, error, verification) {
  const completed = new Date();
  return {ok: ok, action: 'maintenance', mode: mode, operationId: operationId,
    idempotencyKey: idempotencyKey, cycleId: cycleId || '', helperVersion: NW.VERSION,
    repository: repository, steps: steps, verification: verification || null, error: error || '',
    startedAt: formatDate_(started), completedAt: formatDate_(completed),
    durationSeconds: Math.round((completed.getTime() - started.getTime()) / 1000), replayed: false};
}

function verifyCycleCompletion_(ss, cycleId) {
  const cycle = findRefreshCycle_(ss, cycleId);
  const errors = [];
  const coverage = Number(cycle['Coverage %'] || 0) <= 1
    ? Number(cycle['Coverage %'] || 0) * 100
    : Number(cycle['Coverage %'] || 0);
  const unaccounted = Number(cycle.Unaccounted || 0);

  const resolutions = table_(ss, NW.DYNAMIC_RESOLUTIONS).rows.filter(function(r) {
    return String(r['Cycle ID'] || '') === String(cycleId);
  });
  const typed = {
    expectedNoProvider: countClassification_(resolutions, 'Expected No Provider'),
    providerVerificationPending: countClassification_(resolutions, 'Provider Verification Pending'),
    identityResolutionRequired: countClassification_(resolutions, 'Identity Resolution Required'),
    legacyOutstanding: countClassification_(resolutions, 'Outstanding Verification')
  };
  const actionableOutstanding = typed.providerVerificationPending +
    typed.identityResolutionRequired + typed.legacyOutstanding;

  if (coverage < 100) errors.push('Coverage below 100%: ' + coverage);
  if (unaccounted !== 0) errors.push('Unaccounted population: ' + unaccounted);
  if (['Completed','Attention Required'].indexOf(String(cycle.Status)) < 0) {
    errors.push('Unexpected cycle status: ' + cycle.Status);
  }

  return {
    ok: errors.length === 0,
    cycleId: cycleId,
    status: String(cycle.Status),
    coveragePercent: coverage,
    unaccounted: unaccounted,
    outstanding: Number(cycle['Outstanding Verification'] || 0),
    outstandingVerification: actionableOutstanding,
    expectedNoProvider: typed.expectedNoProvider,
    providerVerificationPending: typed.providerVerificationPending,
    identityResolutionRequired: typed.identityResolutionRequired,
    legacyOutstanding: typed.legacyOutstanding,
    errors: errors
  };
}

function findRefreshCycle_(ss, cycleId) {
  const rows = table_(ss, NW.REFRESH_CYCLES).rows;
  const row = rows.find(function(r){ return String(r['Cycle ID']) === String(cycleId); });
  if (!row) throw new Error('Refresh Cycle not found: ' + cycleId);
  return row;
}

function verifyLatestDailyRun_(request) {
  const ss = openRepository_();
  verifyRepository_(ss);
  const dateKey = String(request.dateKey || dailyDateKey_(new Date()));
  const rows = table_(ss, NW.REFRESH_CYCLES).rows.filter(function(r){
    return String(r['Cycle ID']).indexOf('CYC-DYNAMIC-DAILY-' + dateKey) === 0;
  });
  if (!rows.length) return {ok: false, dateKey: dateKey, error: 'No daily cycle found'};
  return verifyCycleCompletion_(ss, String(rows[rows.length - 1]['Cycle ID']));
}

function markCycleAttentionRequired_(ss, cycleId, operationId, error) {
  if (!cycleId) return;
  const sheet = requireSheet_(ss, NW.REFRESH_CYCLES);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String), idx = {};
  headers.forEach(function(h,i){idx[h]=i;});
  const i = values.slice(1).findIndex(function(r){return String(r[idx['Cycle ID']]) === cycleId;});
  if (i < 0) return;
  const row = values[i+1];
  row[idx.Status] = 'Attention Required';
  row[idx['Completed At']] = now_();
  row[idx.Notes] = String(row[idx.Notes] || '') + ' | Orchestrator failure ' + operationId + ': ' + error;
  sheet.getRange(i+2,1,1,headers.length).setValues([row]);
  SpreadsheetApp.flush();
}

/**
 * Maintenance evidence has three governed layers:
 *   - Work Log: one unified terminal summary for Helper / ChatGPT / Ed visibility.
 *   - Refresh Cycles: authoritative lifecycle metrics and reconciliation.
 *   - Audit Log: detailed technical evidence.
 * The legacy optional "Maintenance History" sink remains retired.
 */
function firstPresentMetric_(sources, keys) {
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i] || {};
    for (let j = 0; j < keys.length; j++) {
      const key = keys[j];
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const value = source[key];
      if (value === '' || value === null || value === undefined) continue;
      const numeric = Number(value);
      if (isFinite(numeric)) return {present: true, value: numeric};
    }
  }
  return {present: false, value: 0};
}

function collectMaintenanceWorkLogMetrics_(result) {
  result = result || {};
  const steps = result.steps || [];
  const stepResults = function(prefix) {
    return steps.filter(function(step) {
      return String(step.name || '').indexOf(prefix) === 0;
    }).map(function(step) { return step.result || {}; });
  };
  const mnt013 = stepResults('MNT013');
  const mnt014 = stepResults('MNT014');
  const mnt015 = stepResults('MNT015');
  const mnt016 = stepResults('MNT016');
  const mnt017 = stepResults('MNT017');
  const latest013 = mnt013.length ? mnt013[mnt013.length - 1] : {};
  const latest014 = mnt014.length ? mnt014[mnt014.length - 1] : {};
  const latest015 = mnt015.length ? mnt015[mnt015.length - 1] : {};
  const latest016 = mnt016.length ? mnt016[mnt016.length - 1] : {};
  const latest017 = mnt017.length ? mnt017[mnt017.length - 1] : {};
  const verification = result.verification || {};

  return {
    expected: firstPresentMetric_([latest017, latest013], ['expectedPopulation']),
    processed: firstPresentMetric_([latest013], ['processed']),
    observed: firstPresentMetric_([latest013], ['observed']),
    outstanding: firstPresentMetric_([latest017, latest014, latest013, verification],
      ['outstandingVerification','outstanding']),
    expectedNoProvider: firstPresentMetric_([latest017, latest014, verification],
      ['expectedNoProvider']),
    providerPending: firstPresentMetric_([latest017, latest014, verification],
      ['providerVerificationPending']),
    identityRequired: firstPresentMetric_([latest017, latest014, verification],
      ['identityResolutionRequired']),
    changed: firstPresentMetric_([latest017], ['changed']),
    committed: firstPresentMetric_([latest015], ['recordsCommitted']),
    runtimeViews: firstPresentMetric_([latest017, latest016], ['runtimeViewsVerified','viewsRebuilt']),
    runtimeRows: firstPresentMetric_([latest016], ['runtimeRowsUpdated']),
    coverage: firstPresentMetric_([verification, latest017, latest013], ['coveragePercent']),
    unaccounted: firstPresentMetric_([verification, latest017], ['unaccounted'])
  };
}

function formatMaintenanceMetricSummary_(metrics) {
  const parts = [];
  function add(label, metric, suffix) {
    if (metric && metric.present) parts.push(label + ' ' + metric.value + (suffix || ''));
  }
  add('Expected', metrics.expected);
  add('Processed', metrics.processed);
  add('Observed', metrics.observed);
  add('Outstanding', metrics.outstanding);
  add('Expected No Provider', metrics.expectedNoProvider);
  add('Provider Pending', metrics.providerPending);
  add('Identity Required', metrics.identityRequired);
  add('Changed', metrics.changed);
  add('Committed', metrics.committed);
  add('Runtime Views', metrics.runtimeViews);
  add('Runtime Rows', metrics.runtimeRows);
  add('Coverage', metrics.coverage, '%');
  add('Unaccounted', metrics.unaccounted);
  return parts.join(' | ');
}

function upsertMaintenanceWorkLog_(ss, result, outcome) {
  const sheet = requireSheet_(ss, NW.WORK_LOG);
  const expected = [
    'Event ID','Timestamp','Actor','Run ID','Workflow ID','Trigger','Authority',
    'Action ID','Action','Outcome','Evidence','Before State','After State','Duration',
    'Notes','Legacy Task ID','Legacy Owner','Legacy Timestamp','Legacy Next Due',
    'Legacy Metrics','Legacy Validation','Legacy Summary','Legacy Status','Legacy Version'
  ];
  const headers = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(expected)) {
    throw new Error('Work Log header contract mismatch');
  }

  const eventId = 'MHR-HELPER-' + String(result.idempotencyKey || result.operationId || result.cycleId)
    .replace(/[^A-Za-z0-9_-]/g, '-');
  const stepNames = (result.steps || []).map(function(x) {
    return String(x.name || '') + ':' + (x.ok === false ? 'FAIL' : 'PASS');
  }).filter(String);
  const success = outcome === 'Completed' && result.ok !== false;
  const evidence = [
    result.cycleId ? 'Refresh Cycles ' + result.cycleId : '',
    'Audit Log terminal entry',
    'Helper ' + NW.VERSION
  ].filter(String).join(' | ');
  const notes = success
    ? stepNames.join(' | ')
    : ('Error: ' + String(result.error || 'Unknown helper failure') +
       (stepNames.length ? ' | ' + stepNames.join(' | ') : ''));
  const metrics = formatMaintenanceMetricSummary_(collectMaintenanceWorkLogMetrics_(result));
  const row = [
    eventId,
    result.completedAt || now_(),
    'Daily Helper',
    result.operationId || '',
    'MNT013-MNT017',
    String(result.operationId || '').indexOf('UI-MAINT-FULL-') === 0
      ? 'Manual Apps Script full-maintenance run'
      : 'Apps Script time-driven trigger',
    'Repository Constitution; Workflow Registry; Workflow Procedures',
    result.cycleId || '',
    'Governed helper maintenance',
    outcome,
    evidence,
    success ? 'Scheduled lifecycle started' : 'Last verified state before failure',
    success ? 'Full helper-backed lifecycle completed and verified.' : 'Last verified state preserved.',
    Number(result.durationSeconds || 0),
    notes,
    '', '', '', '',
    metrics,
    success ? 'PASS' : 'FAIL',
    success ? 'Repository maintenance completed' : 'Repository maintenance requires attention',
    success ? 'PASS' : 'FAIL',
    NW.VERSION
  ];

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    const matches = [];
    ids.forEach(function(v, i) { if (String(v[0]) === eventId) matches.push(i + 2); });
    if (matches.length > 1) throw new Error('Duplicate Work Log Event ID: ' + eventId);
    if (matches.length === 1) {
      sheet.getRange(matches[0], 1, 1, row.length).setValues([row]);
      SpreadsheetApp.flush();
      return {ok: true, eventId: eventId, updated: true};
    }
  }
  sheet.appendRow(row);
  SpreadsheetApp.flush();
  return {ok: true, eventId: eventId, updated: false};
}

function runMaintenanceStep_(name, fn) {
  const started = new Date();
  try {
    const result = fn();
    return {
      name,
      ok: !!(result && result.ok),
      startedAt: formatDate_(started),
      completedAt: formatDate_(new Date()),
      result
    };
  } catch (err) {
    return {
      name,
      ok: false,
      startedAt: formatDate_(started),
      completedAt: formatDate_(new Date()),
      error: String(err && err.message ? err.message : err)
    };
  }
}

function health_() {
  const ss = openRepository_();
  const repo = verifyRepository_(ss);
  return {
    ok: true,
    helperVersion: NW.VERSION,
    repository: repo,
    retiredFeatures: {
      watchedMoviesV2: true
    },
    tmdbConfigured: !!getScriptProperty_('TMDB_BEARER_TOKEN', false),
    timestamp: now_()
  };
}

function buildWatchedMoviesV2_(request) {
  throw new Error(
    'Retired operation: Watched Movies v2 is no longer built. ' +
    'Use rebuildDynamicRuntimeViews_ (MNT016), which reads enabled mappings from View Builder Rules.'
  );
}

function readWatchedMovieModel_(ss) {
  const catalog = table_(ss, NW.TITLE_CATALOG);
  const state = table_(ss, NW.TITLE_STATE);
  const intelligence = table_(ss, NW.TITLE_INTELLIGENCE);
  const availability = table_(ss, NW.DYNAMIC_AVAILABILITY);
  const people = table_(ss, NW.PEOPLE);
  const titlePeople = table_(ss, NW.TITLE_PEOPLE);

  const catalogById = indexUnique_(catalog, 'Title ID');
  const intelligenceById = indexUnique_(intelligence, 'Title ID');
  const peopleById = indexUnique_(people, 'Person ID');
  const activeAvailability = {};
  availability.rows.forEach(function(r) {
    if (truthy_(r['Active Record'])) {
      if (activeAvailability[r['Title ID']]) throw new Error('Multiple active availability rows for ' + r['Title ID']);
      activeAvailability[r['Title ID']] = r;
    }
  });
  const castByTitle = {};
  titlePeople.rows.forEach(function(r) {
    if (String(r.Role).toLowerCase() !== 'actor') return;
    const p = peopleById[r['Person ID']];
    if (!p) return;
    if (!castByTitle[r['Title ID']]) castByTitle[r['Title ID']] = [];
    if (castByTitle[r['Title ID']].length < 6) castByTitle[r['Title ID']].push(p.Name);
  });

  const watched = state.rows.filter(function(r) {
    const media = String(r['Media Type'] || '').toLowerCase();
    const repoState = String(r['Repository State'] || '').toLowerCase();
    const watchStatus = String(r['Current Watch Status'] || '').toLowerCase();
    return media === 'movie' && repoState !== 'deleted' &&
      (repoState === 'watched' || ['watched','completed','started','in progress'].indexOf(watchStatus) >= 0) &&
      ['queued','not started','pending recommendation',''].indexOf(watchStatus) < 0;
  });

  return {catalogById, intelligenceById, activeAvailability, castByTitle, watched};
}

function materializeWatchedRows_(model) {
  const material = model.watched.map(function(s) {
    const id = s['Title ID'];
    const c = model.catalogById[id];
    if (!c) throw new Error('Title State ID does not resolve in Title Catalog: ' + id);
    const intel = model.intelligenceById[id] || {};
    const av = model.activeAvailability[id] || {};
    const ratingDisplay = chooseRating_(s['Ed Rating'], intel['Predicted Ed Rating'], s['Predicted Ed']);
    const sortScore = ratingScore_(ratingDisplay);
    const cast = (model.castByTitle[id] || []).join(' | ') || c['Principal Cast'] || 'Unknown';
    return {
      id,
      sortScore,
      title: c['Display Alias'] || c['Canonical Title'],
      row: [
        0,
        id,
        c['Display Alias'] || c['Canonical Title'],
        c['Display Synopsis'] || c['Official Synopsis'],
        cast,
        s['Progress / Scope'] || s['Current Watch Status'],
        ratingDisplay,
        s['Audience Score'] || 'Not available',
        intel['Confidence'] || 'Unknown',
        av['Provider'] || s['Current Availability'] || 'Not verified',
        intel['Why Recommended'] || "You've seen it.",
        intel['Primary Concern'] || 'Already watched.',
        av['Last Verified'] || s['Availability Last Successful Verification'] || 'Not verified',
        c['Official Synopsis'],
        c['Release / Start Year'],
        c['Genres'],
        s['Last Watch Date'] || '2000-01-01',
        s['Progress / Scope'] || s['Current Watch Status'],
        s['State Notes'] || 'No additional notes'
      ]
    };
  });

  material.sort(function(a, b) {
    if (b.sortScore !== a.sortScore) return b.sortScore - a.sortScore;
    return String(a.id).localeCompare(String(b.id));
  });
  material.forEach(function(x, i) { x.row[0] = i + 1; });
  return material.map(function(x) { return x.row; });
}

function validateWatchedV2_(model, rows, baseline) {
  const errors = [];
  const warnings = [];
  const seen = {};
  rows.forEach(function(r, i) {
    const rowNo = i + 2;
    if (r.length !== NW.WMV2_HEADERS.length) errors.push('Row ' + rowNo + ' has ' + r.length + ' columns');
    if (Number(r[0]) !== i + 1) errors.push('Rank mismatch at row ' + rowNo);
    if (!r[1] || seen[r[1]]) errors.push('Missing/duplicate Title ID at row ' + rowNo + ': ' + r[1]);
    seen[r[1]] = true;
    [1,2,3,5,6,13,14,15,16,17,18].forEach(function(col) {
      if (r[col] === '' || r[col] === null || typeof r[col] === 'undefined') errors.push('Blank required field ' + NW.WMV2_HEADERS[col] + ' at row ' + rowNo);
    });
    if (!model.catalogById[r[1]]) errors.push('Unresolved Title ID ' + r[1]);
  });
  if (NW.WMV2_HEADERS[3] !== 'Display Synopsis' || NW.WMV2_HEADERS[NW.WMV2_HEADERS.length - 1] !== 'Notes') {
    errors.push('Header contract is malformed');
  }
  const placeholders = rows.reduce(function(n, r) {
    return n + r.filter(function(v) { return ['Not verified','Unknown','TBD','Not available'].indexOf(String(v)) >= 0; }).length;
  }, 0);
  if (placeholders) warnings.push(placeholders + ' placeholder values reported');

  const baselineRows = Math.max(0, baseline.length - 1);
  if (baselineRows && Math.abs(rows.length - baselineRows) > Math.max(3, Math.ceil(baselineRows * 0.05))) {
    warnings.push('Row count differs materially from baseline: v2=' + rows.length + ', baseline=' + baselineRows);
  }
  return {
    sourcePass: errors.length === 0,
    blockingPass: errors.length === 0,
    errors,
    warnings,
    rows: rows.length,
    placeholderCount: placeholders
  };
}


function buildTmdbAvailabilityObservation_(catalogRow, token, cycleId, operationId, idempotencyKey, observedAt) {
  const base = {
    cycleId: cycleId,
    operationId: operationId,
    idempotencyKey: idempotencyKey,
    titleId: catalogRow['Title ID'],
    title: catalogRow['Canonical Title'],
    mediaType: String(catalogRow['Media Type'] || '').toLowerCase(),
    externalDatabase: 'TMDb',
    externalDatabaseId: '',
    identityMethod: '',
    matchedTitle: '',
    country: 'US',
    observedAt: observedAt,
    flatrate: [],
    free: [],
    ads: [],
    rent: [],
    buy: [],
    providerLink: '',
    status: '',
    error: ''
  };

  let tmdb;
  try {
    tmdb = resolveTmdb_(catalogRow, token);
    base.mediaType = tmdb.mediaType;
    base.externalDatabaseId = tmdb.id;
    base.identityMethod = tmdb.method;
    base.matchedTitle = tmdb.matchedTitle || '';
  } catch (err) {
    base.status = 'Identity Resolution Required';
    base.error = String(err && err.message ? err.message : err);
    return base;
  }

  try {
    const providers = fetchTmdbProviders_(tmdb.mediaType, tmdb.id, token);
    base.flatrate = providers.flatrate || [];
    base.free = providers.free || [];
    base.ads = providers.ads || [];
    base.rent = providers.rent || [];
    base.buy = providers.buy || [];
    base.providerLink = providers.link || '';
    base.status = 'Observed';
    return base;
  } catch (err) {
    base.status = 'Provider Verification Pending';
    base.error = String(err && err.message ? err.message : err);
    return base;
  }
}


/**
 * MNT013 full-population batch collector.
 *
 * A single logical Cycle ID is reused across bounded HTTP requests. Each request:
 *   - recomputes the governed eligible population
 *   - skips Title IDs already observed for the cycle
 *   - appends at most batchSize new observations
 *   - updates one Refresh Cycles row in place
 *
 * This avoids Apps Script execution limits without creating duplicate cycle rows.
 */
function collectDynamicObservationsFullBatch_(request) {
  const operationId = requireText_(request.operationId, 'operationId');
  const idempotencyKey = requireText_(request.idempotencyKey, 'idempotencyKey');
  const prior = readIdempotency_(idempotencyKey);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const scope = String(request.scope || 'all').trim().toLowerCase();
  if (['all', 'movies', 'movie', 'tv'].indexOf(scope) < 0) {
    throw new Error('Unsupported dynamic refresh scope: ' + scope);
  }

  const batchSize = Math.max(1, Math.min(Number(request.batchSize || 25), 50));
  const started = new Date();
  const cycleId = String(request.cycleId || '').trim() || ('CYC-DYNAMIC-' +
    Utilities.formatDate(started, NW.TIMEZONE, 'yyyyMMdd-HHmmss') +
    '-' + Utilities.getUuid().slice(0, 8));

  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);

  try {
    const secondPrior = readIdempotency_(idempotencyKey);
    if (secondPrior) return Object.assign({}, secondPrior, {replayed: true});

    const ss = openRepository_();
    const repository = verifyRepository_(ss);
    const token = getScriptProperty_('TMDB_BEARER_TOKEN', true);
    const catalog = table_(ss, NW.TITLE_CATALOG);
    const state = indexUnique_(table_(ss, NW.TITLE_STATE), 'Title ID');

    const eligible = catalog.rows.filter(function(r) {
      const mediaType = String(r['Media Type']).toLowerCase();
      const scopeMatch = scope === 'all' ||
        ((scope === 'movies' || scope === 'movie') && mediaType === 'movie') ||
        (scope === 'tv' && mediaType === 'tv');
      return scopeMatch &&
        ['movie', 'tv'].indexOf(mediaType) >= 0 &&
        String((state[r['Title ID']] || {})['Repository State'] || '').toLowerCase() !== 'deleted';
    });

    const eligibleIds = {};
    eligible.forEach(function(r) { eligibleIds[String(r['Title ID'])] = true; });

    const existingRows = table_(ss, NW.DYNAMIC_OBSERVATIONS).rows.filter(function(r) {
      return String(r['Cycle ID']) === cycleId;
    });
    const alreadyAttempted = {};
    existingRows.forEach(function(r) {
      const id = String(r['Title ID'] || '');
      if (id && eligibleIds[id]) alreadyAttempted[id] = true;
    });

    const candidates = eligible.filter(function(r) {
      return !alreadyAttempted[String(r['Title ID'])];
    }).slice(0, batchSize);

    const observations = candidates.map(function(c) {
      return buildTmdbAvailabilityObservation_(
        c, token, cycleId, operationId, idempotencyKey, now_()
      );
    });

    appendDynamicObservations_(ss, observations);

    const allCycleRows = existingRows.concat(observations.map(function(x) {
      return {'Title ID': x.titleId, 'Observation Status': x.status};
    }));
    const attemptedIds = {};
    let observed = 0;
    let outstanding = 0;
    allCycleRows.forEach(function(r) {
      const id = String(r['Title ID'] || '');
      if (!id || !eligibleIds[id] || attemptedIds[id]) return;
      attemptedIds[id] = true;
      if (String(r['Observation Status']) === 'Observed') observed++;
      else outstanding++;
    });

    const processed = Object.keys(attemptedIds).length;
    const remaining = Math.max(0, eligible.length - processed);
    const completed = new Date();
    const cycleStatus = remaining === 0 ? 'Observed — Complete' : 'Observed — Partial';

    upsertRefreshCycle_(ss, {
      cycleId: cycleId,
      idempotencyKey: String(request.cycleIdempotencyKey || ('FULL-' + cycleId)),
      startedAt: readRefreshCycleStartedAt_(ss, cycleId) || started,
      completedAt: completed,
      mode: 'Full Population Observation Collection',
      status: cycleStatus,
      expectedPopulation: eligible.length,
      changed: 0,
      reverified: 0,
      unchangedCurrent: 0,
      outstandingVerification: outstanding,
      exempted: 0,
      unaccounted: remaining,
      coveragePercent: eligible.length ? (processed / eligible.length) : 1,
      policyVersion: 'MNT013 Full Population / Helper ' + NW.VERSION,
      notes: 'Scope: ' + scope +
        ' | Batch size: ' + batchSize +
        ' | This batch: ' + observations.length +
        ' | Processed total: ' + processed +
        ' | Observed: ' + observed +
        ' | Outstanding: ' + outstanding +
        ' | Remaining: ' + remaining +
        ' | Observation-only: True'
    });

    const result = {
      ok: true,
      action: 'collect_dynamic_observations_full_batch',
      maintenanceTask: 'MNT013',
      helperVersion: NW.VERSION,
      repository: repository,
      operationId: operationId,
      idempotencyKey: idempotencyKey,
      cycleId: cycleId,
      scope: scope,
      batchSize: batchSize,
      observationsRecorded: observations.length,
      expectedPopulation: eligible.length,
      processed: processed,
      observed: observed,
      outstanding: outstanding,
      remaining: remaining,
      coveragePercent: eligible.length ? (processed / eligible.length) * 100 : 100,
      collectionComplete: remaining === 0,
      cycleStatus: cycleStatus,
      commitApplied: false,
      runtimeRebuildApplied: false,
      publicationApplied: false,
      startedAt: formatDate_(started),
      completedAt: formatDate_(completed),
      durationSeconds: Math.round((completed.getTime() - started.getTime()) / 1000),
      replayed: false
    };

    appendAudit_(ss, 'MNT013 full-population batch', 'Dynamic Refresh', cycleId,
      'Actor: Next Watch Helper | Operation ID: ' + operationId +
      ' | Idempotency Key: ' + idempotencyKey +
      ' | Batch recorded: ' + observations.length +
      ' | Processed total: ' + processed +
      ' | Expected: ' + eligible.length +
      ' | Outstanding: ' + outstanding +
      ' | Remaining: ' + remaining +
      ' | Canonical commit: False');

    storeIdempotency_(idempotencyKey, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function readRefreshCycleStartedAt_(ss, cycleId) {
  const sheet = requireSheet_(ss, NW.REFRESH_CYCLES);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0].map(String);
  const cycleCol = headers.indexOf('Cycle ID');
  const startedCol = headers.indexOf('Started At');
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][cycleCol]) === cycleId) return values[i][startedCol] || null;
  }
  return null;
}

function upsertRefreshCycle_(ss, cycle) {
  const sheet = requireSheet_(ss, NW.REFRESH_CYCLES);
  const expected = [
    'Cycle ID','Idempotency Key','Started At','Completed At','Mode','Status',
    'Expected Population','Changed','Reverified','Unchanged Current',
    'Outstanding Verification','Exempted','Unaccounted','Coverage %',
    'Policy Version','Notes'
  ];
  const headers = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
  if (JSON.stringify(headers) !== JSON.stringify(expected)) {
    throw new Error('Refresh Cycles header contract mismatch');
  }

  const row = [
    cycle.cycleId, cycle.idempotencyKey, formatDate_(cycle.startedAt),
    formatDate_(cycle.completedAt), cycle.mode, cycle.status,
    cycle.expectedPopulation, cycle.changed, cycle.reverified,
    cycle.unchangedCurrent, cycle.outstandingVerification, cycle.exempted,
    cycle.unaccounted, cycle.coveragePercent, cycle.policyVersion, cycle.notes
  ];

  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues();
    const matches = [];
    ids.forEach(function(v, i) {
      if (String(v[0]) === cycle.cycleId) matches.push(i + 2);
    });
    if (matches.length > 1) throw new Error('Duplicate Refresh Cycles rows for Cycle ID: ' + cycle.cycleId);
    if (matches.length === 1) {
      sheet.getRange(matches[0], 1, 1, row.length).setValues([row]);
      SpreadsheetApp.flush();
      return;
    }
  }
  sheet.appendRow(row);
  SpreadsheetApp.flush();
}

/**
 * MNT013 — governed dynamic observation collection.
 *
 * Writes:
 *   - one observation row per attempted title in Dynamic Observations
 *   - one lifecycle row in Refresh Cycles
 *
 * Does not write Dynamic Availability or rebuild runtime views.
 */
function collectDynamicObservations_(request) {
  const operationId = requireText_(request.operationId, 'operationId');
  const idempotencyKey = requireText_(request.idempotencyKey, 'idempotencyKey');
  const prior = readIdempotency_(idempotencyKey);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const dryRun = request.dryRun !== false;
  const scope = String(request.scope || 'all').trim().toLowerCase();
  if (['all', 'movies', 'movie', 'tv'].indexOf(scope) < 0) {
    throw new Error('Unsupported dynamic refresh scope: ' + scope);
  }

  const offset = Math.max(0, Number(request.offset || 0));
  const limit = Math.max(1, Math.min(Number(request.limit || 100), 100));
  const started = new Date();
  const cycleId = String(request.cycleId || '').trim() || ('CYC-DYNAMIC-' +
    Utilities.formatDate(started, NW.TIMEZONE, 'yyyyMMdd-HHmmss') +
    '-' + Utilities.getUuid().slice(0, 8));

  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);

  let ss;
  try {
    const secondPrior = readIdempotency_(idempotencyKey);
    if (secondPrior) return Object.assign({}, secondPrior, {replayed: true});

    ss = openRepository_();
    const repository = verifyRepository_(ss);
    const token = getScriptProperty_('TMDB_BEARER_TOKEN', true);
    const catalog = table_(ss, NW.TITLE_CATALOG);
    const state = indexUnique_(table_(ss, NW.TITLE_STATE), 'Title ID');

    const eligible = catalog.rows.filter(function(r) {
      const mediaType = String(r['Media Type']).toLowerCase();
      const scopeMatch =
        scope === 'all' ||
        ((scope === 'movies' || scope === 'movie') && mediaType === 'movie') ||
        (scope === 'tv' && mediaType === 'tv');

      return scopeMatch &&
        ['movie', 'tv'].indexOf(mediaType) >= 0 &&
        String((state[r['Title ID']] || {})['Repository State'] || '').toLowerCase() !== 'deleted';
    });

    const candidates = eligible.slice(offset, offset + limit);
    const observations = candidates.map(function(c) {
      return buildTmdbAvailabilityObservation_(
        c, token, cycleId, operationId, idempotencyKey, now_()
      );
    });

    appendDynamicObservations_(ss, observations);

    const observed = observations.filter(function(x) {
      return x.status === 'Observed';
    }).length;
    const outstanding = observations.length - observed;
    const remaining = Math.max(0, eligible.length - (offset + candidates.length));
    const completed = new Date();

    appendRefreshCycle_(ss, {
      cycleId,
      idempotencyKey,
      startedAt: started,
      completedAt: completed,
      mode: 'Observation Collection',
      status: outstanding === 0 && remaining === 0 ? 'Observed — Complete' : 'Observed — Partial',
      expectedPopulation: eligible.length,
      changed: 0,
      reverified: 0,
      unchangedCurrent: 0,
      outstandingVerification: outstanding,
      exempted: 0,
      unaccounted: remaining,
      coveragePercent: eligible.length ? ((offset + candidates.length) / eligible.length) : 1,
      policyVersion: 'MNT013 / Helper ' + NW.VERSION,
      notes:
        'Scope: ' + scope +
        ' | Offset: ' + offset +
        ' | Processed: ' + candidates.length +
        ' | Observed: ' + observed +
        ' | Observation-only: True'
    });

    const result = {
      ok: true,
      action: 'collect_dynamic_observations',
      maintenanceTask: 'MNT013',
      operationId,
      idempotencyKey,
      cycleId,
      helperVersion: NW.VERSION,
      repository,
      scope,
      dryRun,
      commitRequested: !dryRun,
      commitApplied: false,
      observationOnly: true,
      observationsRecorded: observations.length,
      refreshCycleRecorded: true,
      expectedPopulation: eligible.length,
      offset,
      limit,
      processed: candidates.length,
      remaining,
      observed,
      outstanding,
      reconciled: false,
      note: 'MNT013 recorded observations and the refresh-cycle lifecycle. Canonical Dynamic Availability was not changed.',
      observations,
      startedAt: formatDate_(started),
      completedAt: formatDate_(completed),
      durationSeconds: Math.round((completed.getTime() - started.getTime()) / 1000),
      replayed: false
    };

    appendAudit_(
      ss,
      'MNT013 observation collection',
      'Dynamic Refresh',
      cycleId,
      'Actor: Next Watch Helper | Operation ID: ' + operationId +
      ' | Idempotency Key: ' + idempotencyKey +
      ' | Scope: ' + scope +
      ' | Expected: ' + eligible.length +
      ' | Processed: ' + candidates.length +
      ' | Observed: ' + observed +
      ' | Outstanding: ' + outstanding +
      ' | Remaining: ' + remaining +
      ' | Canonical commit: False'
    );

    storeIdempotency_(idempotencyKey, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}


/**
 * MNT014 — governed resolution engine.
 *
 * Reads one completed/partial MNT013 observation cycle, compares each observation
 * with the current authoritative Dynamic Availability record and the active
 * Where to Watch policy, and records an immutable resolution row.
 *
 * It does not modify Dynamic Availability and does not rebuild runtime views.
 */
function resolveDynamicObservations_(request) {
  const operationId = requireText_(request.operationId, 'operationId');
  const idempotencyKey = requireText_(request.idempotencyKey, 'idempotencyKey');
  const sourceCycleId = requireText_(request.sourceCycleId, 'sourceCycleId');
  const policyId = String(request.policyId || 'DRP003').trim();

  const prior = readIdempotency_(idempotencyKey);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);
  const started = new Date();
  let ss;

  try {
    const secondPrior = readIdempotency_(idempotencyKey);
    if (secondPrior) return Object.assign({}, secondPrior, {replayed: true});

    ss = openRepository_();
    const repository = verifyRepository_(ss);
    const token = getScriptProperty_('TMDB_BEARER_TOKEN', true);
    const observationsTable = table_(ss, NW.DYNAMIC_OBSERVATIONS);
    const observations = observationsTable.rows.filter(function(r) {
      return String(r['Cycle ID']) === sourceCycleId;
    });
    if (!observations.length) {
      throw new Error('No Dynamic Observations found for cycle: ' + sourceCycleId);
    }

    const policies = table_(ss, 'Dynamic Refresh Policy');
    const policy = policies.rows.find(function(r) {
      return String(r['Policy ID']) === policyId && truthy_(r.Active);
    });
    if (!policy) throw new Error('Active Dynamic Refresh Policy not found: ' + policyId);
    if (String(policy['Dynamic Field']) !== 'Where to Watch') {
      throw new Error('MNT014 currently supports only Where to Watch policy rows');
    }

    const thresholdDays = Number(policy['Freshness Threshold (Days)']);
    if (!isFinite(thresholdDays) || thresholdDays < 0) {
      throw new Error('Invalid freshness threshold for policy ' + policyId);
    }

    const availability = table_(ss, NW.DYNAMIC_AVAILABILITY);
    const canonicalByTitle = selectCanonicalAvailability_(availability.rows);
    const catalogByTitle = indexUnique_(table_(ss, NW.TITLE_CATALOG), 'Title ID');
    const resolvedAt = new Date();

    const resolutions = observations.map(function(obs) {
      const titleId = String(obs['Title ID'] || '');
      return resolveAvailabilityObservation_(
        obs,
        canonicalByTitle[titleId] || null,
        catalogByTitle[titleId] || null,
        policy,
        thresholdDays,
        resolvedAt,
        operationId,
        idempotencyKey,
        token
      );
    });

    appendDynamicResolutions_(ss, resolutions);

    const counts = {
      changed: 0,
      reverified: 0,
      unchangedCurrent: 0,
      expectedNoProvider: 0,
      providerVerificationPending: 0,
      identityResolutionRequired: 0,
      legacyOutstanding: 0,
      legacyExempted: 0,
      outstanding: 0,
      exempted: 0
    };

    resolutions.forEach(function(x) {
      if (x.classification === 'Changed') counts.changed++;
      else if (x.classification === 'Reverified') counts.reverified++;
      else if (x.classification === 'Unchanged Current') counts.unchangedCurrent++;
      else if (x.classification === 'Expected No Provider') counts.expectedNoProvider++;
      else if (x.classification === 'Provider Verification Pending') counts.providerVerificationPending++;
      else if (x.classification === 'Identity Resolution Required') counts.identityResolutionRequired++;
      else if (x.classification === 'Outstanding Verification') counts.legacyOutstanding++;
      else if (x.classification === 'Exempted') counts.legacyExempted++;
      else throw new Error('Unsupported resolution classification: ' + x.classification);
    });

    counts.outstanding = counts.providerVerificationPending +
      counts.identityResolutionRequired + counts.legacyOutstanding;
    counts.exempted = counts.expectedNoProvider + counts.legacyExempted;

    const cycleRow = updateRefreshCycleResolution_(ss, sourceCycleId, counts, resolutions.length, {
      operationId: operationId,
      policyId: policyId,
      policyVersion: String(policy['Policy Version'] || ''),
      resolvedAt: resolvedAt
    });

    const completed = new Date();
    const result = {
      ok: true,
      action: 'resolve_dynamic_observations',
      maintenanceTask: 'MNT014',
      operationId: operationId,
      idempotencyKey: idempotencyKey,
      sourceCycleId: sourceCycleId,
      helperVersion: NW.VERSION,
      repository: repository,
      policy: {
        policyId: policyId,
        policyVersion: String(policy['Policy Version'] || ''),
        freshnessThresholdDays: thresholdDays,
        preservationRule: String(policy['Preservation Rule'] || '')
      },
      commitApplied: false,
      resolutionOnly: true,
      observationsRead: observations.length,
      resolutionsRecorded: resolutions.length,
      classifications: counts,
      expectedNoProvider: counts.expectedNoProvider,
      providerVerificationPending: counts.providerVerificationPending,
      identityResolutionRequired: counts.identityResolutionRequired,
      outstandingVerification: counts.outstanding,
      reconciledPopulation: cycleRow.accounted,
      expectedPopulation: cycleRow.expected,
      unaccounted: cycleRow.unaccounted,
      coveragePercent: cycleRow.coveragePercent,
      cycleStatus: cycleRow.status,
      resolutions: resolutions,
      note: 'MNT014 recorded typed resolutions only. Canonical Dynamic Availability was not changed.',
      startedAt: formatDate_(started),
      completedAt: formatDate_(completed),
      durationSeconds: Math.round((completed.getTime() - started.getTime()) / 1000),
      replayed: false
    };

    appendAudit_(
      ss,
      'MNT014 dynamic resolution',
      'Dynamic Refresh',
      sourceCycleId,
      'Actor: Next Watch Helper | Operation ID: ' + operationId +
      ' | Idempotency Key: ' + idempotencyKey +
      ' | Policy: ' + policyId +
      ' | Resolved: ' + resolutions.length +
      ' | Changed: ' + counts.changed +
      ' | Reverified: ' + counts.reverified +
      ' | Unchanged Current: ' + counts.unchangedCurrent +
      ' | Expected No Provider: ' + counts.expectedNoProvider +
      ' | Provider Verification Pending: ' + counts.providerVerificationPending +
      ' | Identity Resolution Required: ' + counts.identityResolutionRequired +
      ' | Legacy Outstanding: ' + counts.legacyOutstanding +
      ' | Outstanding actionable: ' + counts.outstanding +
      ' | Exempted/normal: ' + counts.exempted +
      ' | Unaccounted: ' + cycleRow.unaccounted +
      ' | Canonical commit: False'
    );

    storeIdempotency_(idempotencyKey, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}


/**
 * MNT015 — governed Dynamic Availability commit engine.
 *
 * Commits only MNT014 resolution rows where Commit Eligible is TRUE. Existing
 * canonical rows are preserved as history and superseded by newly appended
 * authoritative records. No runtime view is rebuilt or published here.
 */
function commitDynamicResolutions_(request) {
  const operationId = requireText_(request.operationId, 'operationId');
  const idempotencyKey = requireText_(request.idempotencyKey, 'idempotencyKey');
  const sourceCycleId = requireText_(request.sourceCycleId, 'sourceCycleId');
  const prior = readIdempotency_(idempotencyKey);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);
  const started = new Date();

  try {
    const secondPrior = readIdempotency_(idempotencyKey);
    if (secondPrior) return Object.assign({}, secondPrior, {replayed: true});

    const ss = openRepository_();
    const repository = verifyRepository_(ss);
    const resolutionTable = table_(ss, NW.DYNAMIC_RESOLUTIONS);
    const cycleResolutions = resolutionTable.rows.filter(function(r) {
      return String(r['Cycle ID']) === sourceCycleId;
    });
    if (!cycleResolutions.length) {
      throw new Error('No Dynamic Resolutions found for cycle: ' + sourceCycleId);
    }

    const eligible = cycleResolutions.filter(function(r) {
      return truthy_(r['Commit Eligible']);
    });
    const duplicateTitleIds = duplicateValues_(eligible.map(function(r) {
      return String(r['Title ID'] || '');
    }).filter(Boolean));
    if (duplicateTitleIds.length) {
      throw new Error('Multiple commit-eligible resolutions for Title ID(s): ' + duplicateTitleIds.join(', '));
    }

    eligible.forEach(function(r) {
      if (!String(r['Resolution ID'] || '')) throw new Error('Commit-eligible resolution is missing Resolution ID');
      if (!String(r['Title ID'] || '')) throw new Error('Commit-eligible resolution is missing Title ID');
      if (!String(r['Proposed Provider'] || '')) throw new Error('Commit-eligible resolution is missing Proposed Provider for ' + r['Title ID']);
      if (!String(r['Proposed Last Verified'] || '')) throw new Error('Commit-eligible resolution is missing Proposed Last Verified for ' + r['Title ID']);
      const classification = String(r.Classification || '');
      if (['Changed', 'Reverified'].indexOf(classification) < 0) {
        throw new Error('Unsupported commit-eligible classification: ' + classification);
      }
    });

    const sheet = requireSheet_(ss, NW.DYNAMIC_AVAILABILITY);
    const originalValues = sheet.getDataRange().getValues();
    const headers = originalValues[0].map(String);
    const expectedHeaders = [
      'Title ID','Provider','Included','Quality','Last Verified','Availability Record ID',
      'Verification Status','Active Record','Supersedes Record ID','Resolver Rank',
      'Selection Reason','Migrated At'
    ];
    if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) {
      throw new Error('Dynamic Availability header contract mismatch');
    }

    const idx = {};
    headers.forEach(function(h, i) { idx[h] = i; });
    const working = originalValues.map(function(r) { return r.slice(); });
    const dataRows = working.slice(1);
    const canonicalRows = dataRows.map(function(row, offset) {
      const obj = {};
      headers.forEach(function(h, i) { obj[h] = row[i]; });
      obj.__rowIndex = offset + 1;
      return obj;
    });
    const selectedByTitle = selectCanonicalAvailability_(canonicalRows);
    const committedAt = new Date();
    const commitRecords = [];

    eligible.forEach(function(resolution) {
      const titleId = String(resolution['Title ID']);
      const priorCanonical = selectedByTitle[titleId] || null;
      const supersedesId = priorCanonical ? String(priorCanonical['Availability Record ID'] || '') : '';

      if (priorCanonical) {
        const oldRow = working[priorCanonical.__rowIndex];
        oldRow[idx['Active Record']] = false;
        oldRow[idx['Selection Reason']] = 'Historical record; superseded by MNT015';
      }

      const included = normalizeIncluded_(resolution['Proposed Included']);
      const recordId = 'AVH-' + Utilities.getUuid();
      const verificationStatus = included === 'TRUE' ? 'Verified included' :
        (included === 'FALSE' ? 'Verified not included' : 'Provider observed; inclusion unverified');
      const newRow = new Array(headers.length).fill('');
      newRow[idx['Title ID']] = titleId;
      newRow[idx.Provider] = String(resolution['Proposed Provider']);
      newRow[idx.Included] = included;
      newRow[idx.Quality] = priorCanonical ? String(priorCanonical.Quality || 'Not specified') : 'Not specified';
      newRow[idx['Last Verified']] = resolution['Proposed Last Verified'];
      newRow[idx['Availability Record ID']] = recordId;
      newRow[idx['Verification Status']] = verificationStatus;
      newRow[idx['Active Record']] = true;
      newRow[idx['Supersedes Record ID']] = supersedesId || 'None';
      newRow[idx['Resolver Rank']] = 1;
      newRow[idx['Selection Reason']] = 'Current authoritative record; committed by MNT015';
      newRow[idx['Migrated At']] = formatDate_(committedAt);
      working.push(newRow);

      commitRecords.push({
        resolutionId: String(resolution['Resolution ID']),
        titleId: titleId,
        classification: String(resolution.Classification || ''),
        priorRecordId: supersedesId,
        newRecordId: recordId,
        provider: String(resolution['Proposed Provider']),
        included: included,
        lastVerified: resolution['Proposed Last Verified']
      });
    });

    // A single full-table write provides the smallest practical transaction boundary.
    // On any error or failed readback, restore the exact pre-commit snapshot.
    try {
      if (sheet.getMaxRows() < working.length) {
        sheet.insertRowsAfter(sheet.getMaxRows(), working.length - sheet.getMaxRows());
      }
      sheet.getRange(1, 1, working.length, headers.length).setValues(working);
      const trailingRows = sheet.getLastRow() - working.length;
      if (trailingRows > 0) {
        sheet.getRange(working.length + 1, 1, trailingRows, headers.length).clearContent();
      }
      SpreadsheetApp.flush();
      const readback = sheet.getRange(1, 1, working.length, headers.length).getValues();
      if (!gridValuesEqual_(working, readback)) {
        throw new Error('Dynamic Availability commit readback mismatch');
      }
    } catch (writeErr) {
      restoreDynamicAvailabilitySnapshot_(sheet, originalValues, headers.length);
      throw new Error('MNT015 commit failed and rollback was applied: ' +
        String(writeErr && writeErr.message ? writeErr.message : writeErr));
    }

    const cycle = updateRefreshCycleCommit_(ss, sourceCycleId, {
      operationId: operationId,
      committedAt: committedAt,
      recordsCommitted: commitRecords.length
    });

    appendAudit_(
      ss,
      'MNT015 dynamic commit',
      'Dynamic Refresh',
      sourceCycleId,
      'Actor: Next Watch Helper | Operation ID: ' + operationId +
      ' | Idempotency Key: ' + idempotencyKey +
      ' | Eligible resolutions: ' + eligible.length +
      ' | Records committed: ' + commitRecords.length +
      ' | Runtime rebuild: False | Publication: False'
    );

    commitRecords.forEach(function(x) {
      appendAudit_(
        ss,
        'MNT015 availability supersession',
        'Dynamic Availability',
        x.newRecordId,
        'Cycle ID: ' + sourceCycleId +
        ' | Resolution ID: ' + x.resolutionId +
        ' | Title ID: ' + x.titleId +
        ' | Supersedes: ' + (x.priorRecordId || 'None') +
        ' | Provider: ' + x.provider +
        ' | Included: ' + x.included +
        ' | Last Verified: ' + x.lastVerified +
        ' | Operation ID: ' + operationId
      );
    });

    const completed = new Date();
    const result = {
      ok: true,
      action: 'commit_dynamic_resolutions',
      maintenanceTask: 'MNT015',
      helperVersion: NW.VERSION,
      repository: repository,
      operationId: operationId,
      idempotencyKey: idempotencyKey,
      sourceCycleId: sourceCycleId,
      resolutionsRead: cycleResolutions.length,
      commitEligible: eligible.length,
      recordsCommitted: commitRecords.length,
      recordsCreated: commitRecords.filter(function(x) { return !x.priorRecordId; }).length,
      recordsSuperseded: commitRecords.filter(function(x) { return !!x.priorRecordId; }).length,
      commitApplied: true,
      runtimeRebuildApplied: false,
      publicationApplied: false,
      cycleStatus: cycle.status,
      commits: commitRecords,
      startedAt: formatDate_(started),
      completedAt: formatDate_(completed),
      durationSeconds: Math.round((completed.getTime() - started.getTime()) / 1000),
      replayed: false
    };
    storeIdempotency_(idempotencyKey, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}


/**
 * MNT016 — post-commit runtime rebuild and verification.
 *
 * Processes every governed dynamic runtime mapping on every completed refresh
 * cycle. Static membership, order, rationale, ratings, and synopsis are preserved
 * byte-for-byte; only governed dynamic availability fields may change. Every
 * mapped STAGE sheet is re-read, written, verified, published to its corresponding
 * VIEW sheet, and re-read—even when the cycle affected zero rows in that view.
 */
function rebuildDynamicRuntimeViews_(request) {
  const operationId = requireText_(request.operationId, 'operationId');
  const idempotencyKey = requireText_(request.idempotencyKey, 'idempotencyKey');
  const sourceCycleId = requireText_(request.sourceCycleId, 'sourceCycleId');
  const prior = readIdempotency_(idempotencyKey);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);
  const started = new Date();
  let ss;
  const snapshots = [];
  try {
    const secondPrior = readIdempotency_(idempotencyKey);
    if (secondPrior) return Object.assign({}, secondPrior, {replayed: true});

    ss = openRepository_();
    const repository = verifyRepository_(ss);
    const cycle = requireRefreshCycleForRebuild_(ss, sourceCycleId);
    setRefreshCycleRuntimeStatus_(ss, sourceCycleId, 'Rebuilding', operationId,
      'MNT016 runtime rebuild started');

    const resolutions = table_(ss, NW.DYNAMIC_RESOLUTIONS).rows.filter(function(r) {
      return String(r['Cycle ID'] || '') === sourceCycleId && truthy_(r['Commit Eligible']);
    });
    const affectedTitleIds = uniqueStrings_(resolutions.map(function(r) {
      return String(r['Title ID'] || '');
    }).filter(Boolean));

    const canonical = selectCanonicalAvailability_(table_(ss, NW.DYNAMIC_AVAILABILITY).rows);
    affectedTitleIds.forEach(function(titleId) {
      if (!canonical[titleId]) throw new Error('No canonical availability row after MNT015 for ' + titleId);
    });

    const runtimeMappings = loadGovernedRuntimeMappings_(ss);

    const viewResults = [];
    let rowsUpdated = 0;
    runtimeMappings.forEach(function(mapping) {
      const viewName = mapping.view;
      const stageName = mapping.stage;
      const view = ss.getSheetByName(viewName);
      if (!view) throw new Error('Required runtime view missing: ' + viewName);
      const originalView = populatedGrid_(view);
      const plan = planDynamicViewPatch_(originalView, affectedTitleIds, canonical, viewName);

      const stage = ss.getSheetByName(stageName);
      if (!stage) throw new Error('Governed runtime view has no staging sheet: ' + stageName);
      const originalStage = populatedGrid_(stage);
      const stagePlan = planDynamicViewPatch_(originalStage, affectedTitleIds, canonical, stageName);
      if (stagePlan.matchingRows !== plan.matchingRows) {
        throw new Error('Stage/view affected-row mismatch for ' + viewName +
          ': stage=' + stagePlan.matchingRows + ', view=' + plan.matchingRows);
      }

      snapshots.push({sheet: stage, values: originalStage});
      snapshots.push({sheet: view, values: originalView});

      writeExactGrid_(stage, stagePlan.values);
      const stageReadback = populatedGrid_(stage);
      if (!gridValuesEqual_(stagePlan.values, stageReadback)) {
        throw new Error('Stage readback mismatch for ' + stageName + ': ' + JSON.stringify(LAST_GRID_MISMATCH_));
      }

      writeExactGrid_(view, plan.values);
      const viewReadback = populatedGrid_(view);
      if (!gridValuesEqual_(stageReadback, viewReadback)) {
        throw new Error('Published runtime view does not match stage: ' + viewName);
      }

      rowsUpdated += plan.matchingRows;
      viewResults.push({
        view: viewName,
        stage: stageName,
        builderType: mapping.builderType,
        rowsUpdated: plan.matchingRows,
        titleIds: plan.titleIds,
        stageVerified: true,
        publicationVerified: true
      });
    });

    setRefreshCycleRuntimeStatus_(ss, sourceCycleId, 'Verifying', operationId,
      'MNT016 affected runtime views rebuilt and verified; reconciliation pending');
    appendAudit_(ss, 'MNT016 runtime rebuild and verification', 'Dynamic Refresh', sourceCycleId,
      'Actor: Next Watch Helper | Operation ID: ' + operationId +
      ' | Idempotency Key: ' + idempotencyKey +
      ' | Affected titles: ' + affectedTitleIds.length +
      ' | Views processed: ' + viewResults.length +
      ' | Runtime rows updated: ' + rowsUpdated +
      ' | Stage verification: Pass | Publication verification: Pass | Success: True');

    const completed = new Date();
    const result = {
      ok: true,
      action: 'rebuild_dynamic_runtime_views',
      maintenanceTask: 'MNT016',
      helperVersion: NW.VERSION,
      repository: repository,
      operationId: operationId,
      idempotencyKey: idempotencyKey,
      sourceCycleId: sourceCycleId,
      affectedTitleIds: affectedTitleIds,
      affectedTitles: affectedTitleIds.length,
      viewsRebuilt: viewResults.length,
      allRuntimeViewsProcessed: viewResults.length === runtimeMappings.length,
      runtimeRowsUpdated: rowsUpdated,
      viewResults: viewResults,
      canonicalCommitApplied: true,
      runtimeRebuildApplied: true,
      runtimeVerificationPassed: true,
      publicationApplied: true,
      downstreamPublicationApplied: false,
      cycleStatus: 'Verifying',
      reconciliationPending: Number(cycle.unaccounted || 0) > 0,
      unaccounted: Number(cycle.unaccounted || 0),
      startedAt: formatDate_(started),
      completedAt: formatDate_(completed),
      durationSeconds: Math.round((completed.getTime() - started.getTime()) / 1000),
      replayed: false
    };
    storeIdempotency_(idempotencyKey, result);
    return result;
  } catch (err) {
    for (let i = snapshots.length - 1; i >= 0; i--) {
      try { writeExactGrid_(snapshots[i].sheet, snapshots[i].values); } catch (ignored) {}
    }
    if (ss) {
      try {
        setRefreshCycleRuntimeStatus_(ss, sourceCycleId, 'Failed', operationId,
          'MNT016 failed; affected runtime sheets restored: ' + String(err.message || err));
        appendAudit_(ss, 'MNT016 runtime rebuild failed', 'Dynamic Refresh', sourceCycleId,
          'Actor: Next Watch Helper | Operation ID: ' + operationId +
          ' | Idempotency Key: ' + idempotencyKey +
          ' | Error: ' + String(err.message || err) +
          ' | Runtime rollback attempted: True | Success: False');
      } catch (ignored2) {}
    }
    throw err;
  } finally {
    lock.releaseLock();
  }
}


/**
 * Loads the enabled governed runtime mappings from View Builder Rules.
 * This is the canonical runtime registry. New or renamed views are picked up
 * without code changes when the rule row, stage tab, and view tab are updated.
 * A novel Builder Type still requires an explicitly supported implementation.
 */
function loadGovernedRuntimeMappings_(ss) {
  return validateGovernedRuntimeMappingsRows_(table_(ss, NW.VIEW_BUILDER_RULES).rows, ss);
}

function validateGovernedRuntimeMappingsRows_(rows, ss) {
  const supported = {};
  NW.SUPPORTED_BUILDER_TYPES.forEach(function(type) { supported[type] = true; });
  const seenViews = {};
  const seenStages = {};
  const mappings = [];

  rows.forEach(function(row, index) {
    if (!truthy_(row['Enabled'])) return;
    const view = String(row['View'] || '').trim();
    const stage = String(row['Candidate Target'] || '').trim();
    const builderType = String(row['Builder Type'] || '').trim();
    const rowNumber = index + 2;

    if (!view) throw new Error('Enabled View Builder Rules row ' + rowNumber + ' has no View');
    if (view.indexOf('VIEW — ') !== 0) {
      throw new Error('Enabled view must begin with VIEW — at row ' + rowNumber + ': ' + view);
    }
    if (!stage) throw new Error('Enabled view has no Candidate Target at row ' + rowNumber + ': ' + view);
    if (stage.indexOf('STAGE — ') !== 0) {
      throw new Error('Candidate Target must begin with STAGE — at row ' + rowNumber + ': ' + stage);
    }
    if (!builderType) throw new Error('Enabled view has no Builder Type at row ' + rowNumber + ': ' + view);
    if (!supported[builderType]) {
      throw new Error('Unsupported Builder Type at row ' + rowNumber + ': ' + builderType + ' for ' + view);
    }
    if (seenViews[view]) throw new Error('Duplicate governed view mapping: ' + view);
    if (seenStages[stage]) throw new Error('Duplicate governed stage mapping: ' + stage);
    if (!ss.getSheetByName(view)) throw new Error('Governed VIEW tab missing: ' + view);
    if (!ss.getSheetByName(stage)) throw new Error('Governed STAGE tab missing: ' + stage);

    seenViews[view] = true;
    seenStages[stage] = true;
    mappings.push({
      view: view,
      stage: stage,
      builderType: builderType,
      outputSchema: String(row['Output Schema'] || '').trim(),
      publishGate: String(row['Publish Gate'] || '').trim()
    });
  });

  if (!mappings.length) throw new Error('No enabled governed runtime mappings found in ' + NW.VIEW_BUILDER_RULES);
  return mappings;
}

/**
 * MNT017 — reconciliation and governed refresh-cycle finalization.
 *
 * Re-reads all governed evidence, verifies committed availability records and
 * stage/runtime parity, then reconciles the complete expected population.
 * A cycle is marked Completed only when every expected title is accounted for
 * and no actionable title remains in Provider Verification Pending, Identity
 * Resolution Required, or legacy Outstanding Verification. Expected No Provider
 * is a normal governed state and does not block completion.
 */
function finalizeDynamicRefreshCycle_(request) {
  const operationId = requireText_(request.operationId, 'operationId');
  const idempotencyKey = requireText_(request.idempotencyKey, 'idempotencyKey');
  const sourceCycleId = requireText_(request.sourceCycleId, 'sourceCycleId');
  const prior = readIdempotency_(idempotencyKey);
  if (prior) return Object.assign({}, prior, {replayed: true});

  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);
  const started = new Date();

  try {
    const secondPrior = readIdempotency_(idempotencyKey);
    if (secondPrior) return Object.assign({}, secondPrior, {replayed: true});

    const ss = openRepository_();
    const repository = verifyRepository_(ss);
    const cycle = requireRefreshCycleForFinalization_(ss, sourceCycleId);
    const observations = table_(ss, NW.DYNAMIC_OBSERVATIONS).rows.filter(function(r) {
      return String(r['Cycle ID'] || '') === sourceCycleId;
    });
    const resolutions = table_(ss, NW.DYNAMIC_RESOLUTIONS).rows.filter(function(r) {
      return String(r['Cycle ID'] || '') === sourceCycleId;
    });
    const availability = table_(ss, NW.DYNAMIC_AVAILABILITY).rows;

    const duplicateResolutionTitleIds = duplicateValues_(resolutions.map(function(r) {
      return String(r['Title ID'] || '');
    }).filter(Boolean));
    if (duplicateResolutionTitleIds.length) {
      throw new Error('Duplicate Dynamic Resolutions for Title ID(s): ' +
        duplicateResolutionTitleIds.join(', '));
    }

    const counts = {
      changed: countClassification_(resolutions, 'Changed'),
      reverified: countClassification_(resolutions, 'Reverified'),
      unchangedCurrent: countClassification_(resolutions, 'Unchanged Current'),
      expectedNoProvider: countClassification_(resolutions, 'Expected No Provider'),
      providerVerificationPending: countClassification_(resolutions, 'Provider Verification Pending'),
      identityResolutionRequired: countClassification_(resolutions, 'Identity Resolution Required'),
      legacyOutstanding: countClassification_(resolutions, 'Outstanding Verification'),
      legacyExempted: countClassification_(resolutions, 'Exempted')
    };
    counts.outstanding = counts.providerVerificationPending +
      counts.identityResolutionRequired + counts.legacyOutstanding;
    counts.exempted = counts.expectedNoProvider + counts.legacyExempted;

    const accounted = counts.changed + counts.reverified + counts.unchangedCurrent +
      counts.outstanding + counts.exempted;
    const expected = Number(cycle.row['Expected Population'] || 0);
    if (accounted > expected) {
      throw new Error('Reconciled population exceeds expected population: ' +
        accounted + ' > ' + expected);
    }
    const unaccounted = Math.max(0, expected - accounted);
    const coverage = expected ? accounted / expected : 1;

    const commitVerification = verifyMnt017CanonicalCommits_(resolutions, availability);
    const runtimeVerification = verifyMnt017RuntimeParity_(ss, commitVerification.titleIds);

    const completedEligible = unaccounted === 0 && counts.outstanding === 0;
    const finalStatus = completedEligible ? 'Completed' : 'Attention Required';
    const reconciliationPassed = true;
    const finalizedAt = new Date();

    updateRefreshCycleFinalization_(ss, sourceCycleId, {
      operationId: operationId,
      finalizedAt: finalizedAt,
      status: finalStatus,
      expected: expected,
      counts: counts,
      accounted: accounted,
      unaccounted: unaccounted,
      coverage: coverage,
      observations: observations.length,
      resolutions: resolutions.length,
      canonicalRecordsVerified: commitVerification.recordsVerified,
      runtimeViewsVerified: runtimeVerification.viewsVerified
    });

    appendAudit_(ss, 'MNT017 refresh reconciliation', 'Dynamic Refresh', sourceCycleId,
      'Actor: Next Watch Helper | Operation ID: ' + operationId +
      ' | Idempotency Key: ' + idempotencyKey +
      ' | Expected: ' + expected +
      ' | Accounted: ' + accounted +
      ' | Changed: ' + counts.changed +
      ' | Reverified: ' + counts.reverified +
      ' | Unchanged Current: ' + counts.unchangedCurrent +
      ' | Expected No Provider: ' + counts.expectedNoProvider +
      ' | Provider Verification Pending: ' + counts.providerVerificationPending +
      ' | Identity Resolution Required: ' + counts.identityResolutionRequired +
      ' | Legacy Outstanding: ' + counts.legacyOutstanding +
      ' | Actionable Outstanding: ' + counts.outstanding +
      ' | Exempted/normal: ' + counts.exempted +
      ' | Unaccounted: ' + unaccounted +
      ' | Coverage: ' + (coverage * 100).toFixed(2) + '%' +
      ' | Canonical records verified: ' + commitVerification.recordsVerified +
      ' | Runtime views verified: ' + runtimeVerification.viewsVerified +
      ' | Final status: ' + finalStatus);

    const attentionParts = [];
    if (counts.providerVerificationPending) {
      attentionParts.push(counts.providerVerificationPending + ' Provider Verification Pending');
    }
    if (counts.identityResolutionRequired) {
      attentionParts.push(counts.identityResolutionRequired + ' Identity Resolution Required');
    }
    if (counts.legacyOutstanding) {
      attentionParts.push(counts.legacyOutstanding + ' legacy Outstanding Verification');
    }

    const result = {
      ok: true,
      action: 'finalize_dynamic_refresh_cycle',
      maintenanceTask: 'MNT017',
      operationId: operationId,
      idempotencyKey: idempotencyKey,
      sourceCycleId: sourceCycleId,
      helperVersion: NW.VERSION,
      repository: repository,
      expectedPopulation: expected,
      observationsRead: observations.length,
      resolutionsRead: resolutions.length,
      changed: counts.changed,
      reverified: counts.reverified,
      unchangedCurrent: counts.unchangedCurrent,
      expectedNoProvider: counts.expectedNoProvider,
      providerVerificationPending: counts.providerVerificationPending,
      identityResolutionRequired: counts.identityResolutionRequired,
      outstandingVerification: counts.outstanding,
      exempted: counts.exempted,
      accounted: accounted,
      unaccounted: unaccounted,
      coveragePercent: coverage * 100,
      canonicalRecordsVerified: commitVerification.recordsVerified,
      runtimeViewsVerified: runtimeVerification.viewsVerified,
      runtimeVerificationPassed: runtimeVerification.passed,
      reconciliationPassed: reconciliationPassed,
      cycleFinalized: completedEligible,
      cycleStatus: finalStatus,
      publicationEligible: completedEligible,
      downstreamPublicationApplied: false,
      attentionRequired: !completedEligible,
      attentionReason: completedEligible ? '' :
        (unaccounted > 0
          ? unaccounted + ' expected title(s) remain unaccounted'
          : attentionParts.join(' | ')),
      startedAt: formatDate_(started),
      completedAt: formatDate_(finalizedAt),
      durationSeconds: Math.round((finalizedAt.getTime() - started.getTime()) / 1000),
      replayed: false
    };
    storeIdempotency_(idempotencyKey, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function requireRefreshCycleForFinalization_(ss, cycleId) {
  const rows = table_(ss, NW.REFRESH_CYCLES).rows;
  const row = rows.find(function(r) { return String(r['Cycle ID'] || '') === cycleId; });
  if (!row) throw new Error('Refresh cycle not found: ' + cycleId);
  const status = String(row.Status || '');
  if (['Verifying','Attention Required','Completed'].indexOf(status) < 0) {
    throw new Error('Cycle is not eligible for MNT017. Current status: ' + status);
  }
  return {row: row};
}

function countClassification_(resolutions, classification) {
  return resolutions.filter(function(r) {
    return String(r.Classification || '') === classification;
  }).length;
}

function verifyMnt017CanonicalCommits_(resolutions, availabilityRows) {
  const eligible = resolutions.filter(function(r) { return truthy_(r['Commit Eligible']); });
  const activeByTitle = {};
  availabilityRows.forEach(function(r) {
    if (!truthy_(r['Active Record'])) return;
    const titleId = String(r['Title ID'] || '');
    if (!titleId) return;
    if (!activeByTitle[titleId]) activeByTitle[titleId] = [];
    activeByTitle[titleId].push(r);
  });

  eligible.forEach(function(resolution) {
    const titleId = String(resolution['Title ID'] || '');
    const active = activeByTitle[titleId] || [];
    if (active.length !== 1) {
      throw new Error('Expected exactly one active Dynamic Availability record for ' +
        titleId + '; found ' + active.length);
    }
    const row = active[0];
    if (String(row['Selection Reason'] || '').indexOf('committed by MNT015') < 0) {
      throw new Error('Active availability record was not committed by MNT015 for ' + titleId);
    }
    if (!providerSetsEqual_(row.Provider, resolution['Proposed Provider'])) {
      throw new Error('Committed provider mismatch for ' + titleId);
    }
    if (normalizeIncluded_(row.Included) !== normalizeIncluded_(resolution['Proposed Included'])) {
      throw new Error('Committed inclusion mismatch for ' + titleId);
    }
    if (canonicalGridValue_(row['Last Verified']) !==
        canonicalGridValue_(resolution['Proposed Last Verified'])) {
      throw new Error('Committed Last Verified mismatch for ' + titleId);
    }
  });

  return {
    recordsVerified: eligible.length,
    titleIds: uniqueStrings_(eligible.map(function(r) { return String(r['Title ID'] || ''); }))
  };
}

function verifyMnt017RuntimeParity_(ss, affectedTitleIds) {
  const runtimeViews = [
    'VIEW — Movies','VIEW — TV','VIEW — Wife','VIEW — Happy Movies','VIEW — Happy TV',
    'VIEW — Friend Recommendations','VIEW — Audiobooks Fiction','VIEW — Audiobooks Nonfiction',
    'VIEW — Canon','VIEW — Coming Soon','VIEW — Theaters','VIEW — Stream Now Movies',
    'VIEW — Stream Now TV','VIEW — Watched Movies','VIEW — Watched TV','VIEW — New This Week',
    'VIEW — Deferred'
  ];
  let viewsVerified = 0;
  const verifiedViews = [];

  runtimeViews.forEach(function(viewName) {
    const view = ss.getSheetByName(viewName);
    const stage = ss.getSheetByName(viewName.replace(/^VIEW — /, 'STAGE — '));
    if (!view && !stage) return;
    if (!view || !stage) throw new Error('Missing stage/runtime pair for ' + viewName);

    const viewGrid = populatedGrid_(view);
    const stageGrid = populatedGrid_(stage);
    const hasAffected = gridContainsAnyTitleId_(viewGrid, affectedTitleIds) ||
      gridContainsAnyTitleId_(stageGrid, affectedTitleIds);
    if (!hasAffected) return;
    if (!gridValuesEqual_(stageGrid, viewGrid)) {
      throw new Error('Stage/runtime drift detected for ' + viewName);
    }
    viewsVerified++;
    verifiedViews.push(viewName);
  });

  return {passed: true, viewsVerified: viewsVerified, views: verifiedViews};
}

function gridContainsAnyTitleId_(grid, titleIds) {
  if (!grid.length || !titleIds.length) return false;
  const headers = grid[0].map(function(x) { return String(x || '').trim(); });
  const idx = headers.indexOf('Title ID');
  if (idx < 0) return false;
  return grid.slice(1).some(function(row) {
    return titleIds.indexOf(String(row[idx] || '')) >= 0;
  });
}

function updateRefreshCycleFinalization_(ss, cycleId, summary) {
  const sheet = requireSheet_(ss, NW.REFRESH_CYCLES);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });
  const pos = values.slice(1).findIndex(function(r) {
    return String(r[idx['Cycle ID']] || '') === cycleId;
  });
  if (pos < 0) throw new Error('Refresh cycle not found: ' + cycleId);
  const row = values[pos + 1];
  row[idx.Mode] = 'Observation + Resolution + Commit + Runtime Rebuild + Reconciliation';
  row[idx.Status] = summary.status;
  if (summary.status === 'Completed') row[idx['Completed At']] = formatDate_(summary.finalizedAt);
  row[idx.Changed] = summary.counts.changed;
  row[idx.Reverified] = summary.counts.reverified;
  row[idx['Unchanged Current']] = summary.counts.unchangedCurrent;
  row[idx['Outstanding Verification']] = summary.counts.outstanding;
  row[idx.Exempted] = summary.counts.exempted;
  row[idx.Unaccounted] = summary.unaccounted;
  row[idx['Coverage %']] = summary.coverage;
  row[idx['Policy Version']] = appendOnce_(String(row[idx['Policy Version']] || ''),
    'Helper ' + NW.VERSION);
  row[idx.Notes] = String(row[idx.Notes] || '') +
    ' | MNT017 Operation: ' + summary.operationId +
    ' | Accounted: ' + summary.accounted + '/' + summary.expected +
    ' | Observations: ' + summary.observations +
    ' | Resolutions: ' + summary.resolutions +
    ' | Expected No Provider: ' + Number(summary.counts.expectedNoProvider || 0) +
    ' | Provider Verification Pending: ' + Number(summary.counts.providerVerificationPending || 0) +
    ' | Identity Resolution Required: ' + Number(summary.counts.identityResolutionRequired || 0) +
    ' | Actionable Outstanding: ' + Number(summary.counts.outstanding || 0) +
    ' | Canonical records verified: ' + summary.canonicalRecordsVerified +
    ' | Runtime views verified: ' + summary.runtimeViewsVerified +
    ' | Status: ' + summary.status;
  sheet.getRange(pos + 2, 1, 1, headers.length).setValues([row]);
  SpreadsheetApp.flush();
  const readback = sheet.getRange(pos + 2, 1, 1, headers.length).getValues()[0];
  if (!gridValuesEqual_([row], [readback])) {
    throw new Error('Refresh Cycles MNT017 readback mismatch');
  }
}

function requireRefreshCycleForRebuild_(ss, cycleId) {
  const rows = table_(ss, NW.REFRESH_CYCLES).rows;
  const row = rows.find(function(r) { return String(r['Cycle ID'] || '') === cycleId; });
  if (!row) throw new Error('Refresh cycle not found: ' + cycleId);
  const status = String(row.Status || '');
  if (['Committed — Awaiting Rebuild','Rebuilding','Failed'].indexOf(status) < 0) {
    throw new Error('Cycle is not eligible for MNT016. Current status: ' + status);
  }
  return {row: row, unaccounted: row.Unaccounted};
}

function setRefreshCycleRuntimeStatus_(ss, cycleId, status, operationId, note) {
  const sheet = requireSheet_(ss, NW.REFRESH_CYCLES);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });
  const pos = values.slice(1).findIndex(function(r) {
    return String(r[idx['Cycle ID']] || '') === cycleId;
  });
  if (pos < 0) throw new Error('Refresh cycle not found: ' + cycleId);
  const row = values[pos + 1];
  row[idx.Status] = status;
  row[idx['Completed At']] = formatDate_(new Date());
  row[idx.Mode] = 'Observation + Resolution + Commit + Runtime Rebuild';
  row[idx['Policy Version']] = appendOnce_(String(row[idx['Policy Version']] || ''), 'Helper ' + NW.VERSION);
  row[idx.Notes] = String(row[idx.Notes] || '') +
    ' | MNT016 Operation: ' + operationId + ' | ' + note;
  sheet.getRange(pos + 2, 1, 1, headers.length).setValues([row]);
  SpreadsheetApp.flush();
}

function planDynamicViewPatch_(grid, affectedTitleIds, canonical, sheetName) {
  if (!grid.length) return {values: grid, matchingRows: 0, titleIds: []};
  const headers = grid[0].map(function(x) { return String(x || '').trim(); });
  const titleIdx = headers.indexOf('Title ID');
  if (titleIdx < 0) return {values: grid, matchingRows: 0, titleIds: []};
  const providerIdx = firstHeaderIndex_(headers, ['Where to Watch','Where to Stream','Current Availability']);
  const verifiedIdx = firstHeaderIndex_(headers, ['Last Verified']);
  // Some governed title views, such as Canon, are intentionally static
  // projections and contain neither availability field. They participate in
  // stage/view parity verification but are not targets for dynamic patching.
  if (providerIdx < 0 && verifiedIdx < 0) {
    return {
      values: grid,
      matchingRows: 0,
      titleIds: [],
      skippedReason: 'No governed availability columns'
    };
  }

  // A view exposing only one member of the governed availability pair is
  // malformed. Fail closed when an affected title is present.
  if (providerIdx < 0 || verifiedIdx < 0) {
    const affectedInSheet = uniqueStrings_(grid.slice(1).map(function(row) {
      const id = String(row[titleIdx] || '');
      return affectedTitleIds.indexOf(id) >= 0 ? id : '';
    }).filter(Boolean));

    if (affectedInSheet.length) {
      throw new Error(
        'Affected title view has incomplete governed availability headers: ' +
        String(sheetName || 'unknown sheet') +
        ' | providerHeader=' + (providerIdx >= 0) +
        ' | lastVerifiedHeader=' + (verifiedIdx >= 0) +
        ' | headers=' + JSON.stringify(headers) +
        ' | affectedTitleIds=' + JSON.stringify(affectedInSheet)
      );
    }

    return {values: grid, matchingRows: 0, titleIds: []};
  }

  const output = grid.map(function(row) { return row.slice(); });
  const touched = [];
  for (let r = 1; r < output.length; r++) {
    const titleId = String(output[r][titleIdx] || '');
    if (affectedTitleIds.indexOf(titleId) < 0) continue;
    const av = canonical[titleId];
    if (!av) throw new Error('Canonical availability missing for affected title ' + titleId);
    output[r][providerIdx] = String(av.Provider || '');
    output[r][verifiedIdx] = av['Last Verified'];
    touched.push(titleId);
  }
  return {values: output, matchingRows: touched.length, titleIds: uniqueStrings_(touched)};
}

function populatedGrid_(sheet) {
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (!lastRow || !lastCol) return [];
  return sheet.getRange(1, 1, lastRow, lastCol).getValues();
}

function writeExactGrid_(sheet, values) {
  if (!values.length || !values[0].length) throw new Error('Cannot write empty runtime grid: ' + sheet.getName());
  if (sheet.getMaxRows() < values.length) sheet.insertRowsAfter(sheet.getMaxRows(), values.length - sheet.getMaxRows());
  if (sheet.getMaxColumns() < values[0].length) sheet.insertColumnsAfter(sheet.getMaxColumns(), values[0].length - sheet.getMaxColumns());
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  const extraRows = sheet.getLastRow() - values.length;
  if (extraRows > 0) sheet.getRange(values.length + 1, 1, extraRows, sheet.getLastColumn()).clearContent();
  const extraCols = sheet.getLastColumn() - values[0].length;
  if (extraCols > 0) sheet.getRange(1, values[0].length + 1, sheet.getLastRow(), extraCols).clearContent();
  SpreadsheetApp.flush();
}

function firstHeaderIndex_(headers, candidates) {
  for (let i = 0; i < candidates.length; i++) {
    const idx = headers.indexOf(candidates[i]);
    if (idx >= 0) return idx;
  }
  return -1;
}

function uniqueStrings_(values) {
  const seen = {};
  return values.filter(function(v) {
    const key = String(v);
    if (!key || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function appendOnce_(base, token) {
  return base.indexOf(token) >= 0 ? base : (base ? base + ' / ' + token : token);
}

function duplicateValues_(values) {
  const seen = {};
  const duplicates = {};
  values.forEach(function(v) {
    if (seen[v]) duplicates[v] = true;
    seen[v] = true;
  });
  return Object.keys(duplicates);
}

var LAST_GRID_MISMATCH_ = null;

function gridValuesEqual_(a, b) {
  LAST_GRID_MISMATCH_ = null;
  if (a.length !== b.length) {
    LAST_GRID_MISMATCH_ = {kind: 'row-count', expected: a.length, actual: b.length};
    console.log('GRID ROW COUNT MISMATCH expected=' + a.length + ' actual=' + b.length);
    return false;
  }

  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) {
      LAST_GRID_MISMATCH_ = {
        kind: 'column-count',
        row: r + 1,
        expected: a[r].length,
        actual: b[r].length
      };
      console.log(
        'GRID COLUMN COUNT MISMATCH row=' + (r + 1) +
        ' expected=' + a[r].length +
        ' actual=' + b[r].length
      );
      return false;
    }

    for (let c = 0; c < a[r].length; c++) {
      const expected = canonicalGridValue_(a[r][c]);
      const actual = canonicalGridValue_(b[r][c]);

      if (expected !== actual && !equivalentGridValues_(a[r][c], b[r][c])) {
        LAST_GRID_MISMATCH_ = {
          kind: 'cell',
          mismatchRow: r + 1,
          mismatchColumn: c + 1,
          expectedRaw: displayGridValue_(a[r][c]),
          actualRaw: displayGridValue_(b[r][c]),
          expectedCanonical: expected,
          actualCanonical: actual,
          expectedType: Object.prototype.toString.call(a[r][c]),
          actualType: Object.prototype.toString.call(b[r][c])
        };
        console.log(JSON.stringify(LAST_GRID_MISMATCH_, null, 2));
        return false;
      }
    }
  }

  return true;
}

function displayGridValue_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString();
  }
  return value;
}

/**
 * Treats a date-only string and a Sheets Date object as equivalent when they
 * represent the same calendar date in the repository timezone.
 *
 * Example:
 *   written:  "2026-07-15"
 *   readback: Date representing 2026-07-15 00:00 America/Los_Angeles
 *
 * Those values differ as UTC instants but are the same governed date.
 */
function equivalentGridValues_(expectedValue, actualValue) {
  const expectedDateOnly = dateOnlyText_(expectedValue);
  const actualDateOnly = dateOnlyText_(actualValue);

  if (expectedDateOnly && actualDateOnly) {
    return expectedDateOnly === actualDateOnly;
  }

  return false;
}

function dateOnlyText_(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, NW.TIMEZONE, 'yyyy-MM-dd');
  }

  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  }

  return null;
}

/**
 * Canonicalizes values for Sheets readback comparison.
 *
 * Google Sheets may legitimately coerce values during setValues(), including:
 * - "TRUE" / "FALSE" strings to booleans
 * - date-like strings to Date values
 * - date values to second precision
 *
 * The commit and rollback guards must detect changed data, not harmless storage
 * coercion. This function normalizes those equivalent representations while
 * preserving meaningful differences.
 */
function canonicalGridValue_(value) {
  if (value === null || typeof value === 'undefined' || value === '') return 'EMPTY';

  if (value instanceof Date && !isNaN(value.getTime())) {
    return 'DATE:' + Math.floor(value.getTime() / 1000);
  }

  if (typeof value === 'boolean') return 'BOOL:' + (value ? 'TRUE' : 'FALSE');
  if (typeof value === 'number') {
    if (!isFinite(value)) return 'NUM:' + String(value);
    return 'NUM:' + String(Number(value));
  }

  const text = String(value).trim();
  const upper = text.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return 'BOOL:' + upper;

  // Sheets may coerce numeric-looking strings (ratings, ranks, years, scores)
  // into numbers. Compare semantic numeric values rather than storage types.
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) {
    return 'NUM:' + String(Number(text));
  }

  // Percentage-formatted cells may read back as decimal numbers.
  const percent = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+))%$/);
  if (percent) return 'NUM:' + String(Number(percent[1]) / 100);

  // Normalize only clearly date-shaped strings. Avoid parsing arbitrary provider
  // names or identifiers that JavaScript might interpret unexpectedly.
  if (/^\d{4}-\d{2}-\d{2}(?:[ T].*)?$/.test(text)) {
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) return 'DATE:' + Math.floor(parsed.getTime() / 1000);
  }

  return 'TEXT:' + text;
}

function restoreDynamicAvailabilitySnapshot_(sheet, snapshot, width) {
  if (sheet.getMaxRows() < snapshot.length) {
    sheet.insertRowsAfter(sheet.getMaxRows(), snapshot.length - sheet.getMaxRows());
  }
  sheet.getRange(1, 1, snapshot.length, width).setValues(snapshot);
  const trailingRows = sheet.getLastRow() - snapshot.length;
  if (trailingRows > 0) {
    sheet.getRange(snapshot.length + 1, 1, trailingRows, width).clearContent();
  }
  SpreadsheetApp.flush();
  const restored = sheet.getRange(1, 1, snapshot.length, width).getValues();
  if (!gridValuesEqual_(snapshot, restored)) {
    throw new Error('CRITICAL: Dynamic Availability rollback readback mismatch');
  }
}

function updateRefreshCycleCommit_(ss, cycleId, metadata) {
  const sheet = requireSheet_(ss, NW.REFRESH_CYCLES);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });
  const rowIndex = values.slice(1).findIndex(function(r) {
    return String(r[idx['Cycle ID']]) === cycleId;
  });
  if (rowIndex < 0) throw new Error('Refresh Cycles row not found for cycle: ' + cycleId);
  const row = values[rowIndex + 1];
  const currentStatus = String(row[idx.Status] || '');
  if (['Resolving', 'Resolved — Complete', 'Attention Required'].indexOf(currentStatus) < 0) {
    throw new Error('Cycle is not eligible for MNT015 commit. Current status: ' + currentStatus);
  }
  const status = 'Committed — Awaiting Rebuild';
  row[idx['Completed At']] = formatDate_(metadata.committedAt);
  row[idx.Mode] = 'Observation + Resolution + Commit';
  row[idx.Status] = status;
  row[idx['Policy Version']] = String(row[idx['Policy Version']] || '') + ' / Helper ' + NW.VERSION;
  row[idx.Notes] = String(row[idx.Notes] || '') +
    ' | MNT015 Operation: ' + metadata.operationId +
    ' | Records committed: ' + metadata.recordsCommitted +
    ' | Runtime rebuild pending';
  sheet.getRange(rowIndex + 2, 1, 1, headers.length).setValues([row]);
  SpreadsheetApp.flush();
  return {status: status};
}

function selectCanonicalAvailability_(rows) {
  const grouped = {};
  rows.forEach(function(r) {
    const id = String(r['Title ID'] || '');
    if (!id) return;
    if (!grouped[id]) grouped[id] = [];
    grouped[id].push(r);
  });

  const selected = {};
  Object.keys(grouped).forEach(function(id) {
    const candidates = grouped[id].slice().sort(function(a, b) {
      const activeA = truthy_(a['Active Record']) ? 1 : 0;
      const activeB = truthy_(b['Active Record']) ? 1 : 0;
      if (activeB !== activeA) return activeB - activeA;
      const currentA = /current authoritative record/i.test(String(a['Selection Reason'] || '')) ? 1 : 0;
      const currentB = /current authoritative record/i.test(String(b['Selection Reason'] || '')) ? 1 : 0;
      if (currentB !== currentA) return currentB - currentA;
      const rankA = Number(a['Resolver Rank'] || 999999);
      const rankB = Number(b['Resolver Rank'] || 999999);
      if (rankA !== rankB) return rankA - rankB;
      return String(b['Last Verified'] || '').localeCompare(String(a['Last Verified'] || ''));
    });
    selected[id] = candidates[0];
  });
  return selected;
}

function resolveAvailabilityObservation_(obs, canonical, catalogRow, policy, thresholdDays, resolvedAt, operationId, idempotencyKey, token) {
  const observedStatus = String(obs['Observation Status'] || '');
  const error = String(obs.Error || '');
  const titleId = String(obs['Title ID'] || '');
  const observed = summarizeObservedAvailability_(obs);
  const canonicalProvider = canonical ? String(canonical.Provider || '') : '';
  const canonicalIncluded = canonical ? normalizeIncluded_(canonical.Included) : '';
  const canonicalLastVerified = canonical ? canonical['Last Verified'] : '';
  const ageDays = canonicalLastVerified ? ageInDays_(canonicalLastVerified, resolvedAt) : null;

  let classification;
  let reason;

  if (observedStatus === 'Identity Resolution Required' ||
      /identity not found|identity.*missing|resolved title identity/i.test(error)) {
    classification = 'Identity Resolution Required';
    reason = error || 'Resolved title identity or external identity is missing';
  } else if (!titleId || !String(obs['External Database ID'] || '')) {
    classification = 'Identity Resolution Required';
    reason = error || 'Resolved title identity or external identity is missing';
  } else if (observedStatus === 'Provider Verification Pending') {
    classification = 'Provider Verification Pending';
    reason = error || 'Provider lookup failed after title identity was resolved';
  } else if (observedStatus !== 'Observed' || error) {
    classification = 'Provider Verification Pending';
    reason = error || 'Provider observation did not complete';
  } else if (!observed.hasEvidence) {
    const applicability = determineProviderApplicability_(
      obs, catalogRow, canonical, token, resolvedAt
    );
    classification = applicability.classification;
    reason = applicability.reason;
  } else if (!canonical) {
    classification = 'Changed';
    reason = 'No canonical Dynamic Availability record exists';
  } else {
    const providerSame = providerSetsEqual_(observed.provider, canonicalProvider);
    const includedSame = observed.included === canonicalIncluded;
    if (!providerSame || !includedSame) {
      classification = 'Changed';
      reason = 'Observed provider or inclusion differs from the canonical value';
    } else if (ageDays === null || ageDays > thresholdDays) {
      classification = 'Reverified';
      reason = 'Observed value matches canonical and refreshes stale verification evidence';
    } else {
      classification = 'Unchanged Current';
      reason = 'Observed value matches canonical and canonical evidence remains within policy threshold';
    }
  }

  const preserve = [
    'Expected No Provider',
    'Provider Verification Pending',
    'Identity Resolution Required',
    'Outstanding Verification'
  ].indexOf(classification) >= 0;

  return {
    resolutionId: 'RES-' + Utilities.getUuid(),
    cycleId: String(obs['Cycle ID'] || ''),
    operationId: operationId,
    idempotencyKey: idempotencyKey,
    titleId: titleId,
    title: String(obs.Title || ''),
    mediaType: String(obs['Media Type'] || ''),
    policyId: String(policy['Policy ID'] || ''),
    policyVersion: String(policy['Policy Version'] || ''),
    thresholdDays: thresholdDays,
    observedAt: obs['Observed At'],
    resolvedAt: formatDate_(resolvedAt),
    observedProvider: observed.provider,
    observedIncluded: observed.included,
    canonicalRecordId: canonical ? String(canonical['Availability Record ID'] || '') : '',
    canonicalProvider: canonicalProvider,
    canonicalIncluded: canonicalIncluded,
    canonicalLastVerified: canonicalLastVerified || '',
    canonicalAgeDays: ageDays === null ? '' : ageDays,
    classification: classification,
    reason: reason,
    proposedProvider: preserve ? canonicalProvider : observed.provider,
    proposedIncluded: preserve ? canonicalIncluded : observed.included,
    proposedLastVerified: preserve || classification === 'Unchanged Current'
      ? canonicalLastVerified
      : obs['Observed At'],
    commitEligible: ['Changed', 'Reverified'].indexOf(classification) >= 0,
    preservationApplied: preserve,
    sourceLink: String(obs['Provider Link'] || ''),
    error: error
  };
}


function determineProviderApplicability_(obs, catalogRow, canonical, token, resolvedAt) {
  const canonicalProvider = canonical ? String(canonical.Provider || '') : '';
  const futureCanonicalDate = extractFutureIsoDate_(canonicalProvider, resolvedAt);
  if (futureCanonicalDate) {
    return {
      classification: 'Expected No Provider',
      reason: 'Not Yet Applicable — verified canonical release state is future-dated (' +
        futureCanonicalDate + '); no watch-provider evidence is expected yet'
    };
  }

  const externalId = String(obs['External Database ID'] || '');
  const mediaType = String(obs['Media Type'] || '').toLowerCase();

  try {
    const release = fetchTmdbReleaseState_(mediaType, externalId, token);
    if (/^\d{4}-\d{2}-\d{2}$/.test(release.date)) {
      const todayKey = Utilities.formatDate(resolvedAt, NW.TIMEZONE, 'yyyy-MM-dd');
      if (release.date > todayKey) {
        return {
          classification: 'Expected No Provider',
          reason: 'Not Yet Applicable — TMDb release state is future-dated (' +
            release.date + '); no watch-provider evidence is expected yet'
        };
      }

      // DRP004 v1.1 defines a governed rolling 21-day theatrical/streaming
      // release window. Only an explicitly verified theatrical-only canonical
      // state may use that window to suppress a provider exception. We do not
      // infer theatrical-only status from a missing TMDb provider response.
      if (mediaType === 'movie' && isExplicitTheatricalState_(canonicalProvider)) {
        const ageDays = isoDateAgeDays_(release.date, resolvedAt);
        if (ageDays !== null && ageDays >= 0 &&
            ageDays <= Number(NW.THEATRICAL_RELEASE_WINDOW_DAYS || 21)) {
          return {
            classification: 'Expected No Provider',
            reason: 'Not Yet Applicable — verified canonical release state is theatrical-only and TMDb release date (' +
              release.date + ') remains inside the governed ' +
              Number(NW.THEATRICAL_RELEASE_WINDOW_DAYS || 21) +
              '-day theatrical release window (day ' + ageDays +
              '); no home watch-provider evidence is required yet'
          };
        }
      }

      return {
        classification: 'Provider Verification Pending',
        reason: 'TMDb returned no provider evidence and the resolved release date (' +
          release.date + ') is current/past and is not inside a verified governed theatrical-only window'
      };
    }
  } catch (err) {
    return {
      classification: 'Provider Verification Pending',
      reason: 'TMDb returned no provider evidence and release-state applicability could not be verified: ' +
        String(err && err.message ? err.message : err)
    };
  }

  const releaseYear = catalogRow ? String(catalogRow['Release / Start Year'] || '').trim() : '';
  const currentYear = Number(Utilities.formatDate(resolvedAt, NW.TIMEZONE, 'yyyy'));
  if (/^\d{4}$/.test(releaseYear) && Number(releaseYear) > currentYear) {
    return {
      classification: 'Expected No Provider',
      reason: 'Not Yet Applicable — canonical release year ' + releaseYear +
        ' is future-dated; no watch-provider evidence is expected yet'
    };
  }

  return {
    classification: 'Provider Verification Pending',
    reason: 'TMDb returned no provider evidence; provider applicability is current or could not be proven Not Yet Applicable'
  };
}

function isExplicitTheatricalState_(providerState) {
  const value = String(providerState || '').trim().toLowerCase();
  if (!value) return false;
  return /(^|\b)(theatrical|theater|theaters|cinema)(\b|$)/.test(value) &&
    !/(stream|digital|vod|rent|buy|netflix|hulu|apple tv\+|prime video|disney\+|max|peacock|paramount)/.test(value);
}

function isoDateAgeDays_(isoDate, resolvedAt) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ''))) return null;
  const todayKey = Utilities.formatDate(resolvedAt, NW.TIMEZONE, 'yyyy-MM-dd');
  const start = new Date(String(isoDate) + 'T12:00:00Z');
  const end = new Date(todayKey + 'T12:00:00Z');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  return Math.floor((end.getTime() - start.getTime()) / 86400000);
}

function fetchTmdbReleaseState_(mediaType, id, token) {
  if (!id) throw new Error('TMDb external identity is missing');
  const normalizedMediaType = String(mediaType || '').toLowerCase() === 'tv' ? 'tv' : 'movie';
  const data = tmdbFetch_(
    'https://api.themoviedb.org/3/' + normalizedMediaType + '/' + encodeURIComponent(id) +
    '?language=en-US',
    token
  );
  return {
    date: normalizedMediaType === 'tv'
      ? String(data.first_air_date || '')
      : String(data.release_date || '')
  };
}

function extractFutureIsoDate_(value, resolvedAt) {
  const matches = String(value || '').match(/\b(20\d{2}-\d{2}-\d{2})\b/g) || [];
  const todayKey = Utilities.formatDate(resolvedAt, NW.TIMEZONE, 'yyyy-MM-dd');
  for (let i = 0; i < matches.length; i++) {
    if (matches[i] > todayKey) return matches[i];
  }
  return '';
}


function summarizeObservedAvailability_(obs) {
  const flat = splitProviders_(obs['Flat-rate Providers']);
  const free = splitProviders_(obs['Free Providers']);
  const ads = splitProviders_(obs['Ad-supported Providers']);
  const rent = splitProviders_(obs['Rent Providers']);
  const buy = splitProviders_(obs['Buy Providers']);
  const includedProviders = uniqueSorted_(flat.concat(free).concat(ads));
  const hasRentBuy = rent.length > 0 || buy.length > 0;
  const display = includedProviders.slice();
  if (hasRentBuy) display.push('Rent-Buy');
  return {
    provider: display.join(' / '),
    included: includedProviders.length ? 'TRUE' : (hasRentBuy ? 'FALSE' : 'Not verified'),
    hasEvidence: includedProviders.length > 0 || hasRentBuy
  };
}

function splitProviders_(value) {
  return String(value || '').split('|').map(function(x) { return x.trim(); }).filter(Boolean);
}

function uniqueSorted_(items) {
  const seen = {};
  items.forEach(function(x) { seen[normalizeProviderName_(x)] = String(x).trim(); });
  return Object.keys(seen).sort().map(function(k) { return seen[k]; });
}

function providerSetsEqual_(a, b) {
  const left = providerTokens_(a);
  const right = providerTokens_(b);
  return JSON.stringify(left) === JSON.stringify(right);
}

function providerTokens_(value) {
  return String(value || '')
    .split(/\s*\/\s*|\s*\|\s*|\s*,\s*/)
    .map(normalizeProviderName_)
    .filter(Boolean)
    .sort();
}

function normalizeProviderName_(value) {
  let s = String(value || '').toLowerCase().trim();
  s = s.replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const aliases = {
    'disney plus': 'disney plus',
    'paramount plus premium': 'paramount plus',
    'paramount plus essential': 'paramount plus',
    'paramount plus amazon channel': 'paramount plus',
    'paramount plus roku premium channel': 'paramount plus',
    'amazon prime video': 'prime video',
    'amazon video': 'amazon video',
    'apple tv store': 'apple tv store',
    'rent buy': 'rent buy'
  };
  return aliases[s] || s;
}

function normalizeIncluded_(value) {
  if (truthy_(value)) return 'TRUE';
  if (value === false || String(value).toUpperCase() === 'FALSE' || String(value) === '0') return 'FALSE';
  return String(value || '').trim() || 'Not verified';
}

function ageInDays_(value, now) {
  const d = value instanceof Date ? value : new Date(String(value));
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - d.getTime()) / 86400000));
}

function appendDynamicResolutions_(ss, resolutions) {
  const headers = [
    'Resolution ID','Cycle ID','Operation ID','Idempotency Key','Title ID','Title','Media Type',
    'Policy ID','Policy Version','Freshness Threshold Days','Observed At','Resolved At',
    'Observed Provider','Observed Included','Canonical Record ID','Canonical Provider',
    'Canonical Included','Canonical Last Verified','Canonical Age Days','Classification','Reason',
    'Proposed Provider','Proposed Included','Proposed Last Verified','Commit Eligible',
    'Preservation Applied','Source Link','Error','Helper Version'
  ];
  const sheet = ensureSheetWithHeaders_(ss, NW.DYNAMIC_RESOLUTIONS, headers);
  if (!resolutions.length) return;
  const rows = resolutions.map(function(x) {
    return [
      x.resolutionId,x.cycleId,x.operationId,x.idempotencyKey,x.titleId,x.title,x.mediaType,
      x.policyId,x.policyVersion,x.thresholdDays,x.observedAt,x.resolvedAt,x.observedProvider,
      x.observedIncluded,x.canonicalRecordId,x.canonicalProvider,x.canonicalIncluded,
      x.canonicalLastVerified,x.canonicalAgeDays,x.classification,x.reason,x.proposedProvider,
      x.proposedIncluded,x.proposedLastVerified,x.commitEligible,x.preservationApplied,
      x.sourceLink,x.error,NW.VERSION
    ];
  });
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  SpreadsheetApp.flush();
}

function updateRefreshCycleResolution_(ss, cycleId, counts, resolvedCount, metadata) {
  const sheet = requireSheet_(ss, NW.REFRESH_CYCLES);
  const values = sheet.getDataRange().getValues();
  const headers = values[0].map(String);
  const idx = {};
  headers.forEach(function(h, i) { idx[h] = i; });
  const rowIndex = values.slice(1).findIndex(function(r) { return String(r[idx['Cycle ID']]) === cycleId; });
  if (rowIndex < 0) throw new Error('Refresh Cycles row not found for cycle: ' + cycleId);
  const row = values[rowIndex + 1];
  const expected = Number(row[idx['Expected Population']] || 0);
  const accounted = counts.changed + counts.reverified + counts.unchangedCurrent +
    counts.outstanding + counts.exempted;
  const unaccounted = Math.max(0, expected - accounted);
  const coverage = expected ? accounted / expected : 1;
  const status = unaccounted > 0
    ? 'Resolving'
    : (counts.outstanding > 0 ? 'Attention Required' : 'Resolved — Complete');

  row[idx['Completed At']] = formatDate_(metadata.resolvedAt);
  row[idx.Mode] = 'Observation + Resolution';
  row[idx.Status] = status;
  row[idx.Changed] = counts.changed;
  row[idx.Reverified] = counts.reverified;
  row[idx['Unchanged Current']] = counts.unchangedCurrent;
  row[idx['Outstanding Verification']] = counts.outstanding;
  row[idx.Exempted] = counts.exempted;
  row[idx.Unaccounted] = unaccounted;
  row[idx['Coverage %']] = coverage;
  row[idx['Policy Version']] = metadata.policyId + ' v' + metadata.policyVersion + ' / Helper ' + NW.VERSION;
  row[idx.Notes] = String(row[idx.Notes] || '') +
    ' | MNT014 Operation: ' + metadata.operationId +
    ' | Resolved: ' + resolvedCount +
    ' | Accounted: ' + accounted +
    ' | Expected No Provider: ' + Number(counts.expectedNoProvider || 0) +
    ' | Provider Verification Pending: ' + Number(counts.providerVerificationPending || 0) +
    ' | Identity Resolution Required: ' + Number(counts.identityResolutionRequired || 0) +
    ' | Actionable Outstanding: ' + Number(counts.outstanding || 0);

  sheet.getRange(rowIndex + 2, 1, 1, headers.length).setValues([row]);
  SpreadsheetApp.flush();
  return {
    expected: expected,
    accounted: accounted,
    unaccounted: unaccounted,
    coveragePercent: coverage * 100,
    status: status
  };
}

/** Backward-compatible alias for the original v1.1 action/function name. */
function refreshStreamingServices_(request) {
  return collectDynamicObservations_(request);
}

function appendDynamicObservations_(ss, observations) {
  const headers = [
    'Cycle ID','Operation ID','Idempotency Key','Title ID','Title','Media Type',
    'External Database','External Database ID','Identity Method','Matched Title',
    'Country','Observed At','Flat-rate Providers','Free Providers','Ad-supported Providers',
    'Rent Providers','Buy Providers','Provider Link','Observation Status','Error',
    'Helper Version'
  ];

  const sheet = ensureSheetWithHeaders_(ss, NW.DYNAMIC_OBSERVATIONS, headers);
  if (!observations.length) return;

  const rows = observations.map(function(x) {
    return [
      x.cycleId, x.operationId, x.idempotencyKey, x.titleId, x.title, x.mediaType,
      x.externalDatabase, x.externalDatabaseId, x.identityMethod, x.matchedTitle,
      x.country, x.observedAt, (x.flatrate || []).join(' | '), (x.free || []).join(' | '),
      (x.ads || []).join(' | '), (x.rent || []).join(' | '), (x.buy || []).join(' | '),
      x.providerLink, x.status, x.error, NW.VERSION
    ];
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  SpreadsheetApp.flush();
}

function appendRefreshCycle_(ss, cycle) {
  const sheet = requireSheet_(ss, NW.REFRESH_CYCLES);
  const headers = sheet.getRange(1, 1, 1, 16).getDisplayValues()[0];
  const expected = [
    'Cycle ID','Idempotency Key','Started At','Completed At','Mode','Status',
    'Expected Population','Changed','Reverified','Unchanged Current',
    'Outstanding Verification','Exempted','Unaccounted','Coverage %',
    'Policy Version','Notes'
  ];

  if (JSON.stringify(headers) !== JSON.stringify(expected)) {
    throw new Error('Refresh Cycles header contract mismatch');
  }

  sheet.appendRow([
    cycle.cycleId,
    cycle.idempotencyKey,
    formatDate_(cycle.startedAt),
    formatDate_(cycle.completedAt),
    cycle.mode,
    cycle.status,
    cycle.expectedPopulation,
    cycle.changed,
    cycle.reverified,
    cycle.unchangedCurrent,
    cycle.outstandingVerification,
    cycle.exempted,
    cycle.unaccounted,
    cycle.coveragePercent,
    cycle.policyVersion,
    cycle.notes
  ]);
}

function ensureSheetWithHeaders_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sheet;
  }

  const existing = sheet.getRange(1, 1, 1, headers.length).getDisplayValues()[0];
  if (sheet.getLastRow() === 0 || existing.every(function(v) { return !v; })) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  } else if (JSON.stringify(existing) !== JSON.stringify(headers)) {
    throw new Error(name + ' header contract mismatch');
  }
  return sheet;
}

function resolveTmdb_(catalogRow, token) {
  if (String(catalogRow['External Database']).toLowerCase() === 'tmdb' && catalogRow['External Database ID'] && catalogRow['External Database ID'] !== 'Not available') {
    return {id: String(catalogRow['External Database ID']), mediaType: String(catalogRow['Media Type']).toLowerCase(), method: 'repository-id'};
  }
  const mediaType = String(catalogRow['Media Type']).toLowerCase() === 'tv' ? 'tv' : 'movie';
  const query = encodeURIComponent(catalogRow['Canonical Title']);
  const year = String(catalogRow['Release / Start Year'] || '').match(/^\d{4}$/) ? catalogRow['Release / Start Year'] : '';
  const yearParam = year ? (mediaType === 'movie' ? '&year=' : '&first_air_date_year=') + year : '';
  const url = 'https://api.themoviedb.org/3/search/' + mediaType + '?query=' + query + '&include_adult=false&language=en-US&page=1' + yearParam;
  const data = tmdbFetch_(url, token);
  if (!data.results || !data.results.length) throw new Error('TMDb identity not found');
  const top = data.results[0];
  return {id: String(top.id), mediaType, method: 'search', matchedTitle: top.title || top.name};
}

function fetchTmdbProviders_(mediaType, id, token) {
  const data = tmdbFetch_('https://api.themoviedb.org/3/' + mediaType + '/' + id + '/watch/providers', token);
  const us = (data.results || {}).US || {};
  return {
    link: us.link || '',
    flatrate: providerNames_(us.flatrate),
    free: providerNames_(us.free),
    ads: providerNames_(us.ads),
    rent: providerNames_(us.rent),
    buy: providerNames_(us.buy)
  };
}

function tmdbFetch_(url, token) {
  const res = UrlFetchApp.fetch(url, {headers: {Authorization: 'Bearer ' + token, accept: 'application/json'}, muteHttpExceptions: true});
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) throw new Error('TMDb HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

function providerNames_(items) {
  return (items || []).sort(function(a,b){return Number(a.display_priority || 999)-Number(b.display_priority || 999);})
    .map(function(x){return x.provider_name;});
}

function writeMaterialized_(sheet, headers, rows) {
  const neededRows = Math.max(2, rows.length + 1);
  const neededCols = headers.length;
  if (sheet.getMaxRows() < neededRows) sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
  if (sheet.getMaxColumns() < neededCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), neededCols - sheet.getMaxColumns());
  sheet.clearContents();
  sheet.getRange(1, 1, 1, neededCols).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, neededCols).setValues(rows);
  sheet.setFrozenRows(1);
}

function appendBuildRun_(ss, x) {
  requireSheet_(ss, NW.BUILD_RUNS).appendRow([
    x.buildId, formatDate_(x.started), formatDate_(x.completed), NW.VERSION,
    'Watched Movies v2 helper API rebuild', x.backup ? x.backup.id : '', x.backup ? x.backup.url : '',
    x.sourceValidation, x.stageValidation, x.publishStatus, 1,
    x.errors || 0, x.warnings || 0, 0, !!x.backup, x.notes || ''
  ]);
}

function appendAudit_(ss, action, objectType, objectId, details) {
  const id = 'AUD-HELPER-' + Utilities.formatDate(new Date(), NW.TIMEZONE, 'yyyyMMdd-HHmmss');
  requireSheet_(ss, NW.AUDIT_LOG).appendRow([id, now_(), action, objectType, objectId, details]);
}

function openRepository_() {
  return SpreadsheetApp.openById(getScriptProperty_('SPREADSHEET_ID', true));
}

function verifyRepository_(ss) {
  if (ss.getName() !== NW.REPOSITORY_TITLE) throw new Error('Repository title mismatch: ' + ss.getName());
  const cert = requireSheet_(ss, 'Repository Certification').getRange('A1:F20').getDisplayValues().flat().join(' | ');
  if (cert.indexOf('v5.3') < 0 || cert.indexOf(NW.CERTIFICATION_TEXT) < 0) throw new Error('Repository version/certification verification failed');
  return {spreadsheetId: ss.getId(), title: ss.getName(), version: NW.REPOSITORY_VERSION, certification: 'Fully Certified'};
}

function table_(ss, sheetName) {
  const sheet = requireSheet_(ss, sheetName);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (!lastRow || !lastCol) throw new Error('Empty table: ' + sheetName);
  const values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(String);
  const rows = values.slice(1).filter(function(r){return r.some(function(v){return v !== '' && v !== null;});}).map(function(r) {
    const out = {};
    headers.forEach(function(h, i){out[h] = r[i];});
    return out;
  });
  return {headers, rows};
}

function indexUnique_(table, key) {
  const out = {};
  table.rows.forEach(function(r) {
    const k = String(r[key] || '');
    if (!k) return;
    if (out[k]) throw new Error('Duplicate ' + key + ': ' + k);
    out[k] = r;
  });
  return out;
}

function chooseRating_(ed, prediction, statePrediction) {
  const value = String(ed || '').trim();
  if (value && !/^not rated$/i.test(value)) return normalizeRatingDisplay_(value);
  if (prediction !== '' && prediction !== null && typeof prediction !== 'undefined') return prediction;
  return statePrediction || 'Not scored';
}

function normalizeRatingDisplay_(v) {
  const n = Number(v);
  if (!isNaN(n)) return n;
  const map = {'S / Canon':10,'Loved / Canon':10,'S':10,'A':9,'B':8,'C':7,'D':6,'F':5};
  return Object.prototype.hasOwnProperty.call(map, v) ? map[v] : v;
}

function ratingScore_(v) {
  const n = Number(v);
  if (!isNaN(n)) return n;
  const s = String(v || '').toUpperCase();
  if (s.indexOf('S') === 0 || s.indexOf('LOVED') === 0) return 10;
  if (s.indexOf('A') === 0) return 9;
  if (s.indexOf('B') === 0) return 8;
  if (s.indexOf('C') === 0) return 7;
  return -1;
}

function readPopulatedValues_(sheet, width) {
  const lastRow = Math.max(1, sheet.getLastRow());
  return sheet.getRange(1, 1, lastRow, width).getValues();
}

function compareMatrices_(a, b) {
  if (a.length !== b.length) return {equal:false, summary:'row count ' + a.length + ' vs ' + b.length};
  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) return {equal:false, summary:'column count mismatch at row ' + (r+1)};
    for (let c = 0; c < a[r].length; c++) {
      if (normalizeCell_(a[r][c]) !== normalizeCell_(b[r][c])) return {equal:false, summary:'first mismatch at R' + (r+1) + 'C' + (c+1)};
    }
  }
  return {equal:true, summary:'exact match'};
}

function compareWatchedViews_(baseline, v2) {
  const baseIds = baseline.slice(1).map(function(r){return String(r[1] || '');}).filter(Boolean);
  const v2Ids = v2.slice(1).map(function(r){return String(r[1] || '');}).filter(Boolean);
  const baseSet = {}; baseIds.forEach(function(x){baseSet[x]=true;});
  const v2Set = {}; v2Ids.forEach(function(x){v2Set[x]=true;});
  return {
    baselineRows: baseIds.length,
    v2Rows: v2Ids.length,
    addedInV2: v2Ids.filter(function(x){return !baseSet[x];}),
    missingFromV2: baseIds.filter(function(x){return !v2Set[x];}),
    identicalMembership: baseIds.length === v2Ids.length && v2Ids.every(function(x){return baseSet[x];}),
    identicalOrder: baseIds.length === v2Ids.length && baseIds.every(function(x,i){return x === v2Ids[i];})
  };
}

function normalizeCell_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, NW.TIMEZONE, 'yyyy-MM-dd');
  }

  if (v === null || typeof v === 'undefined') return '';

  const text = String(v);

  // Google Sheets reads date-only cells back as Date objects even when the
  // materialized source row used an ISO date string. Normalize ISO date-only
  // strings to the same representation so governed readback verification
  // compares semantic values rather than JavaScript storage types.
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return isoDate[1] + '-' + isoDate[2] + '-' + isoDate[3];

  return text;
}

function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) throw new Error('Missing JSON request body');
  try { return JSON.parse(e.postData.contents); }
  catch (err) { throw new Error('Invalid JSON request body'); }
}

function authenticateExternal_(body) {
  const expected = getScriptProperty_('HELPER_SECRET', true);
  const provided = String(body.secret || '');
  if (!provided || !constantTimeEqual_(provided, expected)) throw new Error('Unauthorized');
}

function constantTimeEqual_(a, b) {
  a = String(a); b = String(b);
  let mismatch = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) mismatch |= (a.charCodeAt(i % Math.max(1,a.length)) || 0) ^ (b.charCodeAt(i % Math.max(1,b.length)) || 0);
  return mismatch === 0;
}

/**
 * Next Watch Helper v2.0.3 storage policy.
 *
 * Script Properties contain only compact replay receipts. Detailed
 * observations, resolutions, commits, and verification evidence remain in the
 * canonical Google Sheets repository.
 */
function readIdempotency_(key) {
  const propertyKey = idempotencyPropertyKey_(key);
  const raw = PropertiesService.getScriptProperties().getProperty(propertyKey);

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(
      'Ignoring malformed idempotency receipt ' + propertyKey + ': ' +
      String(err && err.message ? err.message : err)
    );
    return null;
  }
}

function storeIdempotency_(key, result) {
  maintainIdempotencyStorage_({
    reason: 'before_idempotency_store',
    preserveIdempotencyKey: String(key || '')
  });

  const receipt = buildCompactIdempotencyReceipt_(key, result);
  const serialized = JSON.stringify(receipt);
  const maxReceiptBytes = 8000;
  const byteCount = Utilities.newBlob(serialized).getBytes().length;

  if (byteCount > maxReceiptBytes) {
    throw new Error(
      'Compact idempotency receipt exceeded safety limit: ' +
      byteCount + ' bytes for ' + key
    );
  }

  PropertiesService.getScriptProperties().setProperty(
    idempotencyPropertyKey_(key),
    serialized
  );

  maintainIdempotencyStorage_({
    reason: 'after_idempotency_store',
    preserveIdempotencyKey: String(key || '')
  });

  return receipt;
}

function idempotencyPropertyKey_(key) {
  return 'IDEMPOTENCY_' + digest_(key);
}

function buildCompactIdempotencyReceipt_(key, result) {
  result = result || {};

  const receipt = {
    receiptSchemaVersion: 2,
    compactReceipt: true,
    idempotencyKey: String(key || ''),
    storedAt: now_(),
    storedAtEpochMs: new Date().getTime(),

    ok: result.ok !== false,
    action: scalarOrEmpty_(result.action),
    maintenanceTask: scalarOrEmpty_(result.maintenanceTask),
    helperVersion: scalarOrEmpty_(result.helperVersion || NW.VERSION),

    operationId: scalarOrEmpty_(result.operationId),
    cycleId: scalarOrEmpty_(result.cycleId || result.sourceCycleId),
    sourceCycleId: scalarOrEmpty_(result.sourceCycleId || result.cycleId),

    status: scalarOrEmpty_(
      result.status ||
      result.finalStatus ||
      result.cycleStatus
    ),
    finalStatus: scalarOrEmpty_(result.finalStatus),
    cycleStatus: scalarOrEmpty_(result.cycleStatus),

    replayed: false,
    dryRun: result.dryRun === true,
    resolutionOnly: result.resolutionOnly === true,
    commitApplied: result.commitApplied === true,
    runtimeRebuildApplied: result.runtimeRebuildApplied === true,
    cycleFinalized: result.cycleFinalized === true,
    publicationEligible: result.publicationEligible === true,

    expectedPopulation: numberOrZero_(result.expectedPopulation),
    processed: firstNumber_([
      result.processed,
      result.processedTotal
    ]),
    remaining: numberOrZero_(result.remaining),

    observationsRecorded: numberOrZero_(result.observationsRecorded),
    observationsRead: numberOrZero_(result.observationsRead),
    observed: numberOrZero_(result.observed),

    resolutionsRecorded: numberOrZero_(result.resolutionsRecorded),
    reconciledPopulation: numberOrZero_(result.reconciledPopulation),

    recordsCommitted: numberOrZero_(result.recordsCommitted),
    runtimeRowsUpdated: numberOrZero_(result.runtimeRowsUpdated),

    changed: numberOrZero_(result.changed),
    reverified: numberOrZero_(result.reverified),
    unchangedCurrent: numberOrZero_(result.unchangedCurrent),
    outstanding: firstNumber_([
      result.outstanding,
      result.outstandingVerification
    ]),
    outstandingVerification:
      numberOrZero_(result.outstandingVerification),
    exempted: numberOrZero_(result.exempted),
    unaccounted: numberOrZero_(result.unaccounted),
    coveragePercent: normalizeCoveragePercent_(result.coveragePercent),

    failedStage: scalarOrEmpty_(result.failedStage),
    error: truncateText_(result.error, 1000),

    startedAt: scalarOrEmpty_(result.startedAt),
    completedAt: scalarOrEmpty_(result.completedAt),
    durationSeconds: numberOrZero_(result.durationSeconds),

    detailCounts: collectResultDetailCounts_(result)
  };

  if (result.observationSummary) {
    receipt.observationSummary =
      compactSummaryObject_(result.observationSummary);
  }

  if (result.resolutionSummary) {
    receipt.resolutionSummary =
      compactSummaryObject_(result.resolutionSummary);
  }

  if (result.verification) {
    receipt.verification =
      compactVerificationObject_(result.verification);
  }

  return receipt;
}

function compactSummaryObject_(source) {
  const output = {};

  Object.keys(source || {}).forEach(function(key) {
    const value = source[key];

    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      output[key] =
        typeof value === 'string' ? truncateText_(value, 500) : value;
    } else if (Array.isArray(value)) {
      output[key + 'Count'] = value.length;
    }
  });

  return output;
}

function compactVerificationObject_(source) {
  source = source || {};

  return {
    ok: source.ok !== false,
    cycleId: scalarOrEmpty_(source.cycleId),
    status: scalarOrEmpty_(source.status),
    coveragePercent: normalizeCoveragePercent_(source.coveragePercent),
    unaccounted: numberOrZero_(source.unaccounted),
    outstandingVerification:
      numberOrZero_(source.outstandingVerification),
    errorCount: Array.isArray(source.errors) ? source.errors.length : 0,
    errors: Array.isArray(source.errors)
      ? source.errors.slice(0, 5).map(function(value) {
          return truncateText_(value, 300);
        })
      : []
  };
}

function collectResultDetailCounts_(result) {
  const counts = {};

  Object.keys(result || {}).forEach(function(key) {
    const value = result[key];

    if (Array.isArray(value)) {
      counts[key] = value.length;
    }
  });

  return counts;
}

function scalarOrEmpty_(value) {
  if (
    value === null ||
    typeof value === 'undefined'
  ) {
    return '';
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  return '';
}

function numberOrZero_(value) {
  const number = Number(value);
  return isFinite(number) ? number : 0;
}

function firstNumber_(values) {
  for (let i = 0; i < values.length; i++) {
    if (
      values[i] !== null &&
      typeof values[i] !== 'undefined' &&
      values[i] !== ''
    ) {
      const number = Number(values[i]);
      if (isFinite(number)) return number;
    }
  }

  return 0;
}

function normalizeCoveragePercent_(value) {
  const number = Number(value);

  if (!isFinite(number)) return 0;
  return number > 0 && number <= 1 ? number * 100 : number;
}

function truncateText_(value, maxLength) {
  const text = String(value || '');

  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Self-maintaining Script Properties policy for compact idempotency receipts.
 *
 * Rules:
 *   - Receipts for the active maintenance operation are always protected.
 *   - Completed receipts older than the retention window are removed.
 *   - At most IDEMPOTENCY_MAX_RECEIPTS non-protected receipts are retained.
 *   - If total property storage exceeds the warning threshold, the oldest
 *     non-active receipts are removed until storage returns to the target.
 *   - Malformed idempotency receipts are removed because they cannot provide
 *     replay protection.
 *
 * Configuration and NW_* state properties are never deleted here.
 */
function maintainIdempotencyStorage_(request) {
  request = request || {};

  const propertyStore = PropertiesService.getScriptProperties();
  const properties = propertyStore.getProperties();
  const activeState = readMaintenanceState_();
  const activeRootKey = activeState && activeState.idempotencyKey
    ? String(activeState.idempotencyKey)
    : '';
  const explicitlyPreservedKey = String(request.preserveIdempotencyKey || '');
  const nowMs = new Date().getTime();
  const retentionMs = NW.IDEMPOTENCY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const receipts = [];
  let malformedRemoved = 0;
  let expiredRemoved = 0;
  let countRemoved = 0;
  let budgetRemoved = 0;
  let bytesRemoved = 0;

  Object.keys(properties).forEach(function(propertyName) {
    if (propertyName.indexOf('IDEMPOTENCY_') !== 0) return;

    const raw = String(properties[propertyName] || '');
    const bytes = propertyValueBytes_(raw);
    let receipt;

    try {
      receipt = JSON.parse(raw);
    } catch (err) {
      propertyStore.deleteProperty(propertyName);
      malformedRemoved++;
      bytesRemoved += bytes;
      delete properties[propertyName];
      return;
    }

    const receiptKey = String(receipt.idempotencyKey || '');
    const protectedReceipt = idempotencyKeyBelongsToRoot_(receiptKey, activeRootKey) ||
      idempotencyKeyBelongsToRoot_(receiptKey, explicitlyPreservedKey);
    const storedAtMs = receiptStoredAtEpochMs_(receipt);

    receipts.push({
      propertyName: propertyName,
      receiptKey: receiptKey,
      bytes: bytes,
      storedAtMs: storedAtMs,
      protectedReceipt: protectedReceipt
    });
  });

  receipts.forEach(function(entry) {
    if (entry.protectedReceipt) return;
    if (!entry.storedAtMs) return;
    if (nowMs - entry.storedAtMs <= retentionMs) return;

    propertyStore.deleteProperty(entry.propertyName);
    expiredRemoved++;
    bytesRemoved += entry.bytes;
    delete properties[entry.propertyName];
    entry.deleted = true;
  });

  const countCandidates = receipts
    .filter(function(entry) {
      return !entry.deleted && !entry.protectedReceipt;
    })
    .sort(function(a, b) {
      const aTime = a.storedAtMs || 0;
      const bTime = b.storedAtMs || 0;
      return aTime - bTime;
    });

  const protectedCount = receipts.filter(function(entry) {
    return !entry.deleted && entry.protectedReceipt;
  }).length;
  const allowedNonProtectedCount = Math.max(
    0,
    NW.IDEMPOTENCY_MAX_RECEIPTS - protectedCount
  );
  const excessCount = Math.max(0, countCandidates.length - allowedNonProtectedCount);

  countCandidates.slice(0, excessCount).forEach(function(entry) {
    propertyStore.deleteProperty(entry.propertyName);
    countRemoved++;
    bytesRemoved += entry.bytes;
    delete properties[entry.propertyName];
    entry.deleted = true;
  });

  let totalBytes = totalPropertyValueBytes_(properties);

  if (totalBytes > NW.PROPERTY_STORAGE_WARNING_BYTES) {
    receipts
      .filter(function(entry) {
        return !entry.deleted && !entry.protectedReceipt;
      })
      .sort(function(a, b) {
        const aTime = a.storedAtMs || 0;
        const bTime = b.storedAtMs || 0;
        return aTime - bTime;
      })
      .some(function(entry) {
        if (totalBytes <= NW.PROPERTY_STORAGE_TARGET_BYTES) return true;

        propertyStore.deleteProperty(entry.propertyName);
        totalBytes -= entry.bytes;
        budgetRemoved++;
        bytesRemoved += entry.bytes;
        delete properties[entry.propertyName];
        entry.deleted = true;
        return false;
      });
  }

  totalBytes = totalPropertyValueBytes_(properties);

  return {
    ok: totalBytes <= NW.PROPERTY_STORAGE_EMERGENCY_BYTES,
    helperVersion: NW.VERSION,
    reason: String(request.reason || ''),
    retentionDays: NW.IDEMPOTENCY_RETENTION_DAYS,
    maxReceipts: NW.IDEMPOTENCY_MAX_RECEIPTS,
    targetBytes: NW.PROPERTY_STORAGE_TARGET_BYTES,
    warningBytes: NW.PROPERTY_STORAGE_WARNING_BYTES,
    emergencyBytes: NW.PROPERTY_STORAGE_EMERGENCY_BYTES,
    malformedRemoved: malformedRemoved,
    expiredRemoved: expiredRemoved,
    countRemoved: countRemoved,
    budgetRemoved: budgetRemoved,
    totalRemoved: malformedRemoved + expiredRemoved + countRemoved + budgetRemoved,
    bytesRemoved: bytesRemoved,
    finalEstimatedValueBytes: totalBytes,
    activeOperationProtected: !!activeRootKey,
    storageStatus: propertyStorageStatus_(totalBytes)
  };
}

function idempotencyKeyBelongsToRoot_(candidate, root) {
  candidate = String(candidate || '');
  root = String(root || '');
  if (!candidate || !root) return false;
  return candidate === root || candidate.indexOf(root + ':') === 0;
}

function receiptStoredAtEpochMs_(receipt) {
  receipt = receipt || {};

  const explicit = Number(receipt.storedAtEpochMs);
  if (isFinite(explicit) && explicit > 0) return explicit;

  const text = String(
    receipt.storedAt || receipt.completedAt || receipt.startedAt || ''
  ).trim();
  if (!text) return 0;

  const normalized = text
    .replace(/ PDT$/, ' -0700')
    .replace(/ PST$/, ' -0800');
  const parsed = new Date(normalized).getTime();
  return isFinite(parsed) ? parsed : 0;
}

function propertyValueBytes_(value) {
  return Utilities.newBlob(String(value || '')).getBytes().length;
}

function totalPropertyValueBytes_(properties) {
  return Object.keys(properties || {}).reduce(function(total, key) {
    return total + propertyValueBytes_(properties[key]);
  }, 0);
}

function propertyStorageStatus_(totalBytes) {
  if (totalBytes > NW.PROPERTY_STORAGE_EMERGENCY_BYTES) return 'Emergency';
  if (totalBytes > NW.PROPERTY_STORAGE_WARNING_BYTES) return 'Warning';
  if (totalBytes > NW.PROPERTY_STORAGE_TARGET_BYTES) return 'Above Target';
  return 'Healthy';
}

/** Manual operator command. Safe to run at any time. */
function maintainIdempotencyStorage() {
  return maintainIdempotencyStorage_({reason: 'manual'});
}

/** Manual operator command that writes the cleanup report to the execution log. */
function logMaintainIdempotencyStorage() {
  const result = maintainIdempotencyStorage_({reason: 'manual_log'});
  console.log(JSON.stringify(result, null, 2));
  return result;
}

/**
 * Read-only diagnostic. Reports property sizes without exposing values.
 */
/**
 * Manual operator command that writes the read-only storage report
 * to the execution log. Preserved for backward compatibility.
 */
function logScriptPropertyStorage() {
  const result = inspectScriptPropertyStorage();
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function inspectScriptPropertyStorage() {
  const properties =
    PropertiesService.getScriptProperties().getProperties();

  const rows = Object.keys(properties)
    .map(function(key) {
      const value = String(properties[key] || '');

      return {
        key: key,
        bytes: Utilities.newBlob(value).getBytes().length,
        characters: value.length,
        category:
          key.indexOf('IDEMPOTENCY_') === 0
            ? 'Idempotency'
            : key.indexOf('NW_') === 0
              ? 'Next Watch State'
              : 'Configuration'
      };
    })
    .sort(function(a, b) {
      return b.bytes - a.bytes;
    });

  const totalBytes = rows.reduce(function(total, row) {
    return total + row.bytes;
  }, 0);

  const idempotencyRows = rows.filter(function(row) {
    return row.category === 'Idempotency';
  });

  return {
    ok: true,
    helperVersion: NW.VERSION,
    propertyCount: rows.length,
    estimatedValueBytes: totalBytes,
    idempotencyPropertyCount: idempotencyRows.length,
    idempotencyBytes: idempotencyRows.reduce(function(total, row) {
      return total + row.bytes;
    }, 0),
    retentionDays: NW.IDEMPOTENCY_RETENTION_DAYS,
    maxReceipts: NW.IDEMPOTENCY_MAX_RECEIPTS,
    targetBytes: NW.PROPERTY_STORAGE_TARGET_BYTES,
    warningBytes: NW.PROPERTY_STORAGE_WARNING_BYTES,
    emergencyBytes: NW.PROPERTY_STORAGE_EMERGENCY_BYTES,
    storageStatus: propertyStorageStatus_(totalBytes),
    activeMaintenanceStatePresent:
      Object.prototype.hasOwnProperty.call(
        properties,
        'NW_DAILY_MAINTENANCE_STATE'
      ),
    largestProperties: rows.slice(0, 25)
  };
}

/**
 * One-time v2.0.2 storage migration.
 *
 * Deletes only legacy IDEMPOTENCY_ properties. All configuration, secrets,
 * active maintenance state, and lease properties are preserved.
 */
function migrateIdempotencyStorageV202() {
  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);

  try {
    const propertyStore = PropertiesService.getScriptProperties();
    const allProperties = propertyStore.getProperties();
    const activeState = readMaintenanceState_();

    const activeRootKey =
      activeState && activeState.idempotencyKey
        ? String(activeState.idempotencyKey)
        : '';

    const idempotencyPropertyNames = Object.keys(allProperties)
      .filter(function(key) {
        return key.indexOf('IDEMPOTENCY_') === 0;
      });

    const activeReceipts = [];
    let legacyBytesRemoved = 0;
    let malformedReceipts = 0;

    idempotencyPropertyNames.forEach(function(propertyName) {
      const raw = String(allProperties[propertyName] || '');

      legacyBytesRemoved +=
        Utilities.newBlob(raw).getBytes().length;

      try {
        const parsed = JSON.parse(raw);
        const receiptKey = String(parsed.idempotencyKey || '');

        if (
          activeRootKey &&
          (
            receiptKey === activeRootKey ||
            receiptKey.indexOf(activeRootKey + ':') === 0
          )
        ) {
          activeReceipts.push({
            idempotencyKey: receiptKey,
            result: parsed
          });
        }
      } catch (err) {
        malformedReceipts++;
      }
    });

    idempotencyPropertyNames.forEach(function(propertyName) {
      propertyStore.deleteProperty(propertyName);
    });

    let activeReceiptsRestored = 0;

    activeReceipts.forEach(function(entry) {
      storeIdempotency_(entry.idempotencyKey, entry.result);
      activeReceiptsRestored++;
    });

    const finalProperties = propertyStore.getProperties();
    const finalIdempotencyNames = Object.keys(finalProperties)
      .filter(function(key) {
        return key.indexOf('IDEMPOTENCY_') === 0;
      });

    return {
      ok: true,
      helperVersion: NW.VERSION,
      activeStatePreserved: !!activeState,
      activeOperationId:
        activeState ? activeState.operationId : '',
      activeCycleId:
        activeState ? activeState.cycleId : '',
      activePhase:
        activeState ? activeState.phase : '',
      legacyIdempotencyPropertiesRemoved:
        idempotencyPropertyNames.length,
      legacyBytesRemoved: legacyBytesRemoved,
      activeReceiptsRestored: activeReceiptsRestored,
      malformedReceiptsRemoved: malformedReceipts,
      finalIdempotencyPropertyCount:
        finalIdempotencyNames.length
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Verifies and prepares the existing checkpoint for recovery without advancing
 * its lifecycle phase.
 */
function prepareExistingMaintenanceStateForResume() {
  const lock = LockService.getScriptLock();
  lock.waitLock(NW.LOCK_WAIT_MS);

  try {
    const propertyStore = PropertiesService.getScriptProperties();
    const raw = propertyStore.getProperty(
      'NW_DAILY_MAINTENANCE_STATE'
    );

    if (!raw) {
      throw new Error(
        'No NW_DAILY_MAINTENANCE_STATE checkpoint exists. ' +
        'A new cycle was not created.'
      );
    }

    let state;

    try {
      state = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        'NW_DAILY_MAINTENANCE_STATE is malformed: ' +
        String(err && err.message ? err.message : err)
      );
    }

    const requiredFields = [
      'operationId',
      'idempotencyKey',
      'cycleId',
      'phase',
      'startedAtMs'
    ];

    const missingFields = requiredFields.filter(function(field) {
      return (
        state[field] === null ||
        typeof state[field] === 'undefined' ||
        state[field] === ''
      );
    });

    if (missingFields.length) {
      throw new Error(
        'Maintenance checkpoint is missing required fields: ' +
        missingFields.join(', ')
      );
    }

    const allowedPhases = [
      'MNT013',
      'MNT014',
      'MNT015',
      'MNT016',
      'MNT017',
      'MNT012',
      'VERIFY'
    ];

    if (allowedPhases.indexOf(String(state.phase)) < 0) {
      throw new Error(
        'Unsupported persisted maintenance phase: ' + state.phase
      );
    }

    delete state.error;
    delete state.status;

    state.recoveryPreparedAt = now_();
    state.recoveryPreparedBy = 'Next Watch Helper ' + NW.VERSION;
    state.updatedAtMs = new Date().getTime();

    writeMaintenanceState_(state);

    return {
      ok: true,
      helperVersion: NW.VERSION,
      statePreserved: true,
      operationId: state.operationId,
      idempotencyKey: state.idempotencyKey,
      cycleId: state.cycleId,
      phase: state.phase,
      batchNumber: numberOrZero_(state.batchNumber),
      completedStepCount:
        Array.isArray(state.steps) ? state.steps.length : 0,
      nextAction:
        'Run continueDailyMaintenance() exactly once'
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Read-only checkpoint display.
 */
function inspectMaintenanceRecoveryState() {
  const state = readMaintenanceState_();

  if (!state) {
    return {
      ok: true,
      helperVersion: NW.VERSION,
      activeState: false
    };
  }

  return {
    ok: true,
    helperVersion: NW.VERSION,
    activeState: true,
    operationId: state.operationId,
    idempotencyKey: state.idempotencyKey,
    cycleId: state.cycleId,
    phase: state.phase,
    batchNumber: numberOrZero_(state.batchNumber),
    startedAt: state.startedAt,
    updatedAtMs: state.updatedAtMs,
    error: state.error || '',
    status: state.status || '',
    completedSteps: Array.isArray(state.steps)
      ? state.steps.map(function(step) {
          return {
            name: step.name,
            ok: step.ok,
            completedAt: step.completedAt
          };
        })
      : []
  };
}

function digest_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s));
  return bytes.map(function(b){const x=(b+256)%256; return ('0'+x.toString(16)).slice(-2);}).join('');
}

function getScriptProperty_(name, required) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (required && !value) throw new Error('Missing Script Property: ' + name);
  return value || '';
}

function requireText_(value, field) {
  const s = String(value || '').trim();
  if (!s) throw new Error('Missing required field: ' + field);
  if (s.length > 200) throw new Error(field + ' is too long');
  return s;
}

function requireSheet_(ss, name) {
  const sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Missing required sheet: ' + name);
  return sheet;
}

function truthy_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE' || String(v) === '1';
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj, null, 2)).setMimeType(ContentService.MimeType.JSON);
}

function now_() { return formatDate_(new Date()); }
function formatDate_(value) {
  if (value === null || typeof value === 'undefined' || value === '') return '';

  let d = value;
  if (!(d instanceof Date)) {
    const text = String(d).trim();

    // Refresh Cycles may return a displayed timestamp such as
    // "2026-07-29 00:35:59 PDT" on a later batch. Utilities.formatDate only
    // accepts a Date, so normalize stored strings before formatting them.
    const parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      d = parsed;
    } else {
      const parts = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
      if (!parts) throw new Error('Invalid date value: ' + text);
      d = new Date(
        Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]),
        Number(parts[4]), Number(parts[5]), Number(parts[6])
      );
    }
  }

  if (isNaN(d.getTime())) throw new Error('Invalid date value');
  return Utilities.formatDate(d, NW.TIMEZONE, 'yyyy-MM-dd HH:mm:ss z');
}

/** Regression guard: the retired MNT012 endpoint must remain disabled. */
function testMnt012Api() {
  let retired = false;
  try {
    route_({action: 'build_watched_movies_v2'});
  } catch (err) {
    retired = String(err && err.message ? err.message : err).indexOf('Retired action') >= 0;
  }
  if (!retired) throw new Error('Retired MNT012 endpoint is unexpectedly enabled');
  return {ok: true, retired: true, helperVersion: NW.VERSION};
}


/** Starts a resumable full-population MNT013 collection. */
function testMnt013FullPopulation() {
  const props = PropertiesService.getScriptProperties();
  const tz = Session.getScriptTimeZone() || NW.TIMEZONE;
  const suffix = Utilities.formatDate(new Date(), tz, 'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  props.setProperties({
    MNT013_FULL_CYCLE_ID: 'CYC-DYNAMIC-FULL-' + suffix,
    MNT013_FULL_OPERATION_ID: 'TEST-MNT013-FULL-' + suffix,
    MNT013_FULL_NEXT_BATCH: '1'
  });
  return continueMnt013FullPopulation();
}

/**
 * Continues a full-population collection for up to four bounded web requests.
 * Run again if collectionComplete is false. Progress is persisted in Script Properties.
 */
function continueMnt013FullPopulation() {
  const props = PropertiesService.getScriptProperties();
  const url = requireText_(props.getProperty('WEB_APP_URL'), 'WEB_APP_URL');
  const secret = requireText_(props.getProperty('HELPER_SECRET'), 'HELPER_SECRET');
  const cycleId = requireText_(props.getProperty('MNT013_FULL_CYCLE_ID'), 'MNT013_FULL_CYCLE_ID');
  const baseOperationId = requireText_(props.getProperty('MNT013_FULL_OPERATION_ID'), 'MNT013_FULL_OPERATION_ID');
  let nextBatch = Number(props.getProperty('MNT013_FULL_NEXT_BATCH') || 1);
  const batchSize = 25;
  const batchesPerInvocation = 4;
  let finalResult = null;

  for (let i = 0; i < batchesPerInvocation; i++, nextBatch++) {
    const batchOperationId = baseOperationId + '-B' + String(nextBatch).padStart(2, '0');
    const result = postHelperTestRequest_(url, {
      action: 'collect_dynamic_observations_full_batch',
      operationId: batchOperationId,
      idempotencyKey: batchOperationId,
      cycleId: cycleId,
      cycleIdempotencyKey: baseOperationId,
      scope: 'all',
      batchSize: batchSize,
      secret: secret
    }, 'MNT013 full population batch ' + nextBatch);

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) throw new Error('MNT013 full-population batch returned ok=false');
    if (result.cycleId !== cycleId) throw new Error('MNT013 changed the shared Cycle ID');
    if (result.helperVersion !== NW.VERSION) throw new Error('Unexpected helper version: ' + result.helperVersion);
    finalResult = result;

    props.setProperty('MNT013_FULL_NEXT_BATCH', String(nextBatch + 1));
    if (result.collectionComplete) {
      if (result.processed !== result.expectedPopulation || result.remaining !== 0) {
        throw new Error('MNT013 full population count mismatch: ' + JSON.stringify(result));
      }
      props.deleteProperty('MNT013_FULL_CYCLE_ID');
      props.deleteProperty('MNT013_FULL_OPERATION_ID');
      props.deleteProperty('MNT013_FULL_NEXT_BATCH');
      console.log('✅ MNT013 full-population collection PASSED for ' + result.processed + ' titles');
      return result;
    }
  }

  console.log('⏳ MNT013 full population paused safely. Run continueMnt013FullPopulation() again.');
  return finalResult;
}

/**
 * Tests MNT013 through the deployed web-app endpoint.
 * Uses a small five-title batch so the persisted observation rows are easy to inspect.
 */
function testMnt013Api() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEB_APP_URL');
  const secret = props.getProperty('HELPER_SECRET');

  if (!url) throw new Error('Missing Script Property: WEB_APP_URL');
  if (!secret) throw new Error('Missing Script Property: HELPER_SECRET');

  const suffix = Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss'
  );
  const operationId = 'TEST-MNT013-' + suffix;

  const payload = {
    action: 'collect_dynamic_observations',
    operationId: operationId,
    idempotencyKey: operationId,
    scope: 'all',
    dryRun: true,
    offset: 0,
    limit: 5,
    secret: secret
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = response.getResponseCode();
  const body = response.getContentText();
  console.log('HTTP ' + status);
  console.log(body);

  if (status !== 200) {
    throw new Error('MNT013 API test failed with HTTP ' + status + ': ' + body);
  }

  let result;
  try {
    result = JSON.parse(body);
  } catch (err) {
    throw new Error('MNT013 returned non-JSON content: ' + body.substring(0, 500));
  }

  if (!result.ok) throw new Error('MNT013 returned ok=false: ' + body);
  if (!result.refreshCycleRecorded) throw new Error('MNT013 did not confirm Refresh Cycles persistence');
  if (result.observationsRecorded !== result.processed) {
    throw new Error('MNT013 persistence count mismatch: ' + body);
  }

  return result;
}


/**
 * MNT014 API test against the five-title MNT013 cycle created on 2026-07-28.
 * Uses a stable idempotency key so accidental reruns replay instead of duplicating rows.
 */
function testMnt014Api() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEB_APP_URL');
  const secret = props.getProperty('HELPER_SECRET');
  if (!url) throw new Error('Missing Script Property: WEB_APP_URL');
  if (!secret) throw new Error('Missing Script Property: HELPER_SECRET');

  const operationId = 'TEST-MNT014-CYC-DYNAMIC-20260728-221928-425c6b96';
  const payload = {
    action: 'resolve_dynamic_observations',
    operationId: operationId,
    idempotencyKey: operationId,
    sourceCycleId: 'CYC-DYNAMIC-20260728-221928-425c6b96',
    policyId: 'DRP003',
    secret: secret
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  console.log('HTTP ' + status);
  console.log(body);
  if (status !== 200) throw new Error('MNT014 API test failed with HTTP ' + status + ': ' + body);

  let result;
  try { result = JSON.parse(body); }
  catch (err) { throw new Error('MNT014 returned non-JSON content: ' + body.substring(0, 500)); }
  if (!result.ok) throw new Error('MNT014 returned ok=false: ' + body);
  if (!result.resolutionOnly || result.commitApplied) throw new Error('MNT014 violated resolution-only contract');
  if (result.resolutionsRecorded !== 5) throw new Error('Expected five MNT014 resolutions: ' + body);
  console.log('✅ MNT014 resolution test PASSED');
  return result;
}

/**
 * Executes the deployed dry-run orchestrator with fresh request identity.
 */
function testDynamicMaintenanceDryRun() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEB_APP_URL');
  const secret = props.getProperty('HELPER_SECRET');
  if (!url) throw new Error('Missing Script Property: WEB_APP_URL');
  if (!secret) throw new Error('Missing Script Property: HELPER_SECRET');

  const suffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  const operationId = 'TEST-DRY-RUN-' + suffix;
  const result = postHelperTestRequest_(url, {
    action: 'run_dynamic_maintenance_dry_run',
    operationId: operationId,
    idempotencyKey: operationId,
    scope: 'all',
    offset: 0,
    limit: 5,
    secret: secret
  }, 'Dynamic maintenance dry-run');

  assertDynamicMaintenanceDryRunResult_(result);
  console.log('✅ Dynamic maintenance dry-run integration test PASSED');
  return result;
}

/**
 * Executes the exact same dry-run request twice and verifies replay behavior and
 * that the second request creates no additional cycle, observation, resolution,
 * or audit rows.
 */
function testDynamicMaintenanceDryRunReplay() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEB_APP_URL');
  const secret = props.getProperty('HELPER_SECRET');
  if (!url) throw new Error('Missing Script Property: WEB_APP_URL');
  if (!secret) throw new Error('Missing Script Property: HELPER_SECRET');

  const suffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  const operationId = 'TEST-DRY-RUN-REPLAY-' + suffix;
  const payload = {
    action: 'run_dynamic_maintenance_dry_run',
    operationId: operationId,
    idempotencyKey: operationId,
    scope: 'all',
    offset: 0,
    limit: 5,
    secret: secret
  };

  const first = postHelperTestRequest_(url, payload, 'Dynamic maintenance dry-run replay first request');
  assertDynamicMaintenanceDryRunResult_(first);
  if (first.replayed) throw new Error('First dry-run request unexpectedly replayed');

  const ss = openRepository_();
  const before = dryRunPersistenceCounts_(ss, first.cycleId, operationId);
  const second = postHelperTestRequest_(url, payload, 'Dynamic maintenance dry-run replay second request');
  const after = dryRunPersistenceCounts_(ss, first.cycleId, operationId);

  if (!second.replayed) throw new Error('Second dry-run request did not report replayed=true');
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('Replay created duplicate persisted rows. Before=' +
      JSON.stringify(before) + ' After=' + JSON.stringify(after));
  }
  console.log('✅ Dynamic maintenance dry-run replay test PASSED');
  return {ok: true, first: first, second: second, before: before, after: after};
}

function postHelperTestRequest_(url, payload, label) {
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const status = response.getResponseCode();
  const body = response.getContentText();
  console.log(label + ' HTTP ' + status);
  console.log(body);
  if (status !== 200) throw new Error(label + ' failed with HTTP ' + status + ': ' + body);
  try { return JSON.parse(body); }
  catch (err) { throw new Error(label + ' returned non-JSON content: ' + body.substring(0, 500)); }
}

function assertDynamicMaintenanceDryRunResult_(result) {
  if (!result || !result.ok) throw new Error('Dry-run orchestrator returned ok=false: ' + JSON.stringify(result));
  if (!result.dryRun || result.commitApplied || result.runtimeRebuildApplied) {
    throw new Error('Dry-run safety contract failed: ' + JSON.stringify(result));
  }
  if (!result.observationSummary || result.observationSummary.cycleId !== result.cycleId) {
    throw new Error('MNT013 did not use the orchestrator Cycle ID');
  }
  if (!result.resolutionSummary || result.resolutionSummary.sourceCycleId !== result.cycleId) {
    throw new Error('MNT014 did not use the orchestrator Cycle ID');
  }
  if (result.cycleStatus !== 'Resolving') {
    throw new Error('Expected cycleStatus=Resolving: ' + JSON.stringify(result));
  }
  if (result.coveragePercent < 0 || result.coveragePercent > 100) {
    throw new Error('coveragePercent is not a true percentage: ' + result.coveragePercent);
  }
  if (!result.repository || result.repository.title !== NW.REPOSITORY_TITLE ||
      result.repository.version !== NW.REPOSITORY_VERSION ||
      String(result.repository.certification).toLowerCase().indexOf('certified') < 0) {
    throw new Error('Repository verification missing or incorrect: ' + JSON.stringify(result.repository));
  }
}

function dryRunPersistenceCounts_(ss, cycleId, operationId) {
  return {
    refreshCycles: countTableRowsMatching_(ss, NW.REFRESH_CYCLES, 'Cycle ID', cycleId),
    observations: countTableRowsMatching_(ss, NW.DYNAMIC_OBSERVATIONS, 'Cycle ID', cycleId),
    resolutions: countTableRowsMatching_(ss, NW.DYNAMIC_RESOLUTIONS, 'Cycle ID', cycleId),
    audits: countTableRowsContaining_(ss, NW.AUDIT_LOG, 'Details', 'Operation ID: ' + operationId)
  };
}

function countTableRowsMatching_(ss, sheetName, columnName, expected) {
  const t = table_(ss, sheetName);
  return t.rows.filter(function(r) { return String(r[columnName]) === String(expected); }).length;
}

function countTableRowsContaining_(ss, sheetName, columnName, fragment) {
  const t = table_(ss, sheetName);
  return t.rows.filter(function(r) {
    return String(r[columnName] || '').indexOf(fragment) >= 0;
  }).length;
}



/**
 * MNT015 API integration test. Commits the latest Resolving cycle that contains
 * at least one commit-eligible resolution. This is a real canonical write test.
 */
function testMnt015Api() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEB_APP_URL');
  const secret = props.getProperty('HELPER_SECRET');
  if (!url) throw new Error('Missing Script Property: WEB_APP_URL');
  if (!secret) throw new Error('Missing Script Property: HELPER_SECRET');

  const sourceCycleId = latestCommitEligibleCycleId_();
  const suffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  const operationId = 'TEST-MNT015-' + suffix;
  const result = postHelperTestRequest_(url, {
    action: 'commit_dynamic_resolutions',
    operationId: operationId,
    idempotencyKey: operationId,
    sourceCycleId: sourceCycleId,
    secret: secret
  }, 'MNT015 dynamic commit');

  assertMnt015Result_(result);
  console.log('✅ MNT015 dynamic commit integration test PASSED');
  return result;
}

/** Runs a fresh MNT013+MNT014 dry-run, commits it once, then verifies replay. */
function testMnt015Replay() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty('WEB_APP_URL');
  const secret = props.getProperty('HELPER_SECRET');
  if (!url) throw new Error('Missing Script Property: WEB_APP_URL');
  if (!secret) throw new Error('Missing Script Property: HELPER_SECRET');

  const dryRun = testDynamicMaintenanceDryRun();
  const suffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  const operationId = 'TEST-MNT015-REPLAY-' + suffix;
  const payload = {
    action: 'commit_dynamic_resolutions',
    operationId: operationId,
    idempotencyKey: operationId,
    sourceCycleId: dryRun.cycleId,
    secret: secret
  };

  const first = postHelperTestRequest_(url, payload, 'MNT015 replay first request');
  assertMnt015Result_(first);
  if (first.replayed) throw new Error('First MNT015 request unexpectedly replayed');
  const ss = openRepository_();
  const before = mnt015PersistenceCounts_(ss, dryRun.cycleId, operationId);
  const second = postHelperTestRequest_(url, payload, 'MNT015 replay second request');
  const after = mnt015PersistenceCounts_(ss, dryRun.cycleId, operationId);
  if (!second.replayed) throw new Error('Second MNT015 request did not report replayed=true');
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('MNT015 replay created duplicate writes. Before=' +
      JSON.stringify(before) + ' After=' + JSON.stringify(after));
  }
  console.log('✅ MNT015 replay test PASSED');
  return {ok: true, first: first, second: second, before: before, after: after};
}


/** Integration test for MNT016 against the latest committed cycle with changes. */
function testMnt016Api() {
  const url = requireText_(getScriptProperty_('WEB_APP_URL', true), 'WEB_APP_URL');
  const secret = requireText_(getScriptProperty_('HELPER_SECRET', true), 'HELPER_SECRET');
  const cycleId = latestMnt016EligibleCycleId_(true);
  const suffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  const operationId = 'TEST-MNT016-' + suffix;
  const result = postHelperTestRequest_(url, {
    action: 'rebuild_dynamic_runtime_views',
    operationId: operationId,
    idempotencyKey: operationId,
    sourceCycleId: cycleId,
    secret: secret
  }, 'MNT016 runtime rebuild');
  assertMnt016Result_(result);
  console.log('✅ MNT016 runtime rebuild integration test PASSED');
  return result;
}

/** Replay test confirms no duplicate runtime publication or audit activity. */
function testMnt016Replay() {
  const url = requireText_(getScriptProperty_('WEB_APP_URL', true), 'WEB_APP_URL');
  const secret = requireText_(getScriptProperty_('HELPER_SECRET', true), 'HELPER_SECRET');
  const cycleId = latestMnt016EligibleCycleId_(false);
  const suffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  const operationId = 'TEST-MNT016-REPLAY-' + suffix;
  const payload = {
    action: 'rebuild_dynamic_runtime_views', operationId: operationId,
    idempotencyKey: operationId, sourceCycleId: cycleId, secret: secret
  };
  const first = postHelperTestRequest_(url, payload, 'MNT016 replay first request');
  assertMnt016Result_(first);
  const ss = openRepository_();
  const before = countTableRowsContaining_(ss, NW.AUDIT_LOG, 'Details', 'Operation ID: ' + operationId);
  const second = postHelperTestRequest_(url, payload, 'MNT016 replay second request');
  const after = countTableRowsContaining_(ss, NW.AUDIT_LOG, 'Details', 'Operation ID: ' + operationId);
  if (!second.replayed) throw new Error('Second MNT016 request did not report replayed=true');
  if (before !== after) throw new Error('MNT016 replay duplicated audit rows');
  console.log('✅ MNT016 replay test PASSED');
  return {ok: true, first: first, second: second, auditsBefore: before, auditsAfter: after};
}


/** Integration test for MNT017 against the latest cycle in Verifying status. */
function testMnt017Api() {
  const url = requireText_(getScriptProperty_('WEB_APP_URL', true), 'WEB_APP_URL');
  const secret = requireText_(getScriptProperty_('HELPER_SECRET', true), 'HELPER_SECRET');
  const cycleId = latestMnt017EligibleCycleId_();
  const suffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  const operationId = 'TEST-MNT017-' + suffix;
  const result = postHelperTestRequest_(url, {
    action: 'finalize_dynamic_refresh_cycle',
    operationId: operationId,
    idempotencyKey: operationId,
    sourceCycleId: cycleId,
    secret: secret
  }, 'MNT017 reconciliation');
  assertMnt017Result_(result);
  console.log('✅ MNT017 reconciliation integration test PASSED');
  return result;
}

/** Replay test confirms no duplicate finalization audit or cycle mutation. */
function testMnt017Replay() {
  const url = requireText_(getScriptProperty_('WEB_APP_URL', true), 'WEB_APP_URL');
  const secret = requireText_(getScriptProperty_('HELPER_SECRET', true), 'HELPER_SECRET');
  const cycleId = latestMnt017EligibleCycleId_();
  const suffix = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || NW.TIMEZONE,
    'yyyyMMdd-HHmmss') + '-' + Utilities.getUuid().slice(0, 8);
  const operationId = 'TEST-MNT017-REPLAY-' + suffix;
  const payload = {
    action: 'finalize_dynamic_refresh_cycle', operationId: operationId,
    idempotencyKey: operationId, sourceCycleId: cycleId, secret: secret
  };
  const first = postHelperTestRequest_(url, payload, 'MNT017 replay first request');
  assertMnt017Result_(first);
  const ss = openRepository_();
  const before = countTableRowsContaining_(ss, NW.AUDIT_LOG, 'Details',
    'Operation ID: ' + operationId);
  const second = postHelperTestRequest_(url, payload, 'MNT017 replay second request');
  const after = countTableRowsContaining_(ss, NW.AUDIT_LOG, 'Details',
    'Operation ID: ' + operationId);
  if (!second.replayed) throw new Error('Second MNT017 request did not report replayed=true');
  if (before !== after) throw new Error('MNT017 replay duplicated audit rows');
  console.log('✅ MNT017 replay test PASSED');
  return {ok: true, first: first, second: second, auditsBefore: before, auditsAfter: after};
}

function latestMnt017EligibleCycleId_() {
  const ss = openRepository_();
  const cycles = table_(ss, NW.REFRESH_CYCLES).rows;
  for (let i = cycles.length - 1; i >= 0; i--) {
    const status = String(cycles[i].Status || '');
    if (['Verifying','Attention Required'].indexOf(status) >= 0) {
      return String(cycles[i]['Cycle ID'] || '');
    }
  }
  throw new Error('No MNT017-eligible refresh cycle found');
}

function assertMnt017Result_(result) {
  if (!result || !result.ok) throw new Error('MNT017 returned ok=false: ' + JSON.stringify(result));
  if (!result.reconciliationPassed || !result.runtimeVerificationPassed) {
    throw new Error('MNT017 verification contract failed: ' + JSON.stringify(result));
  }
  if (result.unaccounted > 0 && result.cycleStatus === 'Completed') {
    throw new Error('MNT017 completed a cycle with unaccounted titles: ' + JSON.stringify(result));
  }
  if (result.outstandingVerification > 0 && result.cycleStatus === 'Completed') {
    throw new Error('MNT017 completed a cycle with outstanding verification: ' + JSON.stringify(result));
  }
  if (result.unaccounted === 0 && result.outstandingVerification === 0 &&
      result.cycleStatus !== 'Completed') {
    throw new Error('MNT017 failed to complete a fully reconciled cycle: ' + JSON.stringify(result));
  }
}

function latestMnt016EligibleCycleId_(requireChanges) {
  const ss = openRepository_();
  const cycles = table_(ss, NW.REFRESH_CYCLES).rows;
  const resolutions = table_(ss, NW.DYNAMIC_RESOLUTIONS).rows;
  for (let i = cycles.length - 1; i >= 0; i--) {
    const cycleId = String(cycles[i]['Cycle ID'] || '');
    const status = String(cycles[i].Status || '');
    if (['Committed — Awaiting Rebuild','Failed'].indexOf(status) < 0) continue;
    const eligible = resolutions.filter(function(r) {
      return String(r['Cycle ID'] || '') === cycleId && truthy_(r['Commit Eligible']);
    }).length;
    if (!requireChanges || eligible > 0) return cycleId;
  }
  throw new Error('No MNT016-eligible refresh cycle found' + (requireChanges ? ' with committed changes' : ''));
}

function assertMnt016Result_(result) {
  if (!result || !result.ok) throw new Error('MNT016 returned ok=false: ' + JSON.stringify(result));
  if (!result.runtimeRebuildApplied || !result.runtimeVerificationPassed || !result.publicationApplied) {
    throw new Error('MNT016 lifecycle contract failed: ' + JSON.stringify(result));
  }
  if (result.downstreamPublicationApplied) throw new Error('MNT016 published downstream output unexpectedly');
  if (result.cycleStatus !== 'Verifying') throw new Error('Unexpected MNT016 cycle status: ' + result.cycleStatus);
}

function latestCommitEligibleCycleId_() {
  const ss = openRepository_();
  const resolutions = table_(ss, NW.DYNAMIC_RESOLUTIONS).rows;
  const eligible = resolutions.filter(function(r) { return truthy_(r['Commit Eligible']); });
  if (!eligible.length) throw new Error('No commit-eligible Dynamic Resolutions are available');
  return String(eligible[eligible.length - 1]['Cycle ID']);
}

function assertMnt015Result_(result) {
  if (!result || !result.ok) throw new Error('MNT015 returned ok=false: ' + JSON.stringify(result));
  if (!result.commitApplied || result.runtimeRebuildApplied || result.publicationApplied) {
    throw new Error('MNT015 lifecycle contract failed: ' + JSON.stringify(result));
  }
  if (result.recordsCommitted !== result.commitEligible) {
    throw new Error('MNT015 eligible/committed count mismatch: ' + JSON.stringify(result));
  }
  if (result.cycleStatus !== 'Committed — Awaiting Rebuild') {
    throw new Error('Unexpected MNT015 cycle status: ' + result.cycleStatus);
  }
}


function mnt015PersistenceCounts_(ss, cycleId, operationId) {
  const availability = table_(ss, NW.DYNAMIC_AVAILABILITY).rows;
  return {
    availabilityRows: availability.length,
    activeCommittedRows: availability.filter(function(r) {
      return String(r['Selection Reason'] || '').indexOf('committed by MNT015') >= 0;
    }).length,
    cycleRows: countTableRowsMatching_(ss, NW.REFRESH_CYCLES, 'Cycle ID', cycleId),
    audits: countTableRowsContaining_(ss, NW.AUDIT_LOG, 'Details', 'Operation ID: ' + operationId)
  };
}

/**
 * Manual operator verification for Helper v2.2.3 typed dynamic verification.
 *
 * Safe test path: executes the existing dynamic-maintenance dry run (MNT013 +
 * MNT014 only) and then asserts that the v2.2.3 typed-verification contract is
 * present in the result. It does NOT run MNT015 canonical commits, MNT016
 * runtime rebuilds, or MNT017 final publication/finalization.
 *
 * Run this function directly from the Apps Script editor before enabling or
 * trusting the scheduled production lifecycle after a helper deployment.
 */
function runTypedVerificationFullPopulationDryRunV221_() {
  const suffix = Utilities.formatDate(new Date(), NW.TIMEZONE, 'yyyyMMdd-HHmmss');
  const operationId = 'TEST-TYPED-V221-' + suffix;
  const idempotencyKey = operationId;
  const cycleId = 'CYC-TYPED-V221-' + suffix + '-' + Utilities.getUuid().slice(0, 8);
  const source = 'Manual v2.2.3 full-population typed-verification test';
  const batchSize = 50;
  const started = new Date();

  const ss = openRepository_();
  const repository = verifyRepository_(ss);
  let batchNumber = 0;
  let observationResult = null;
  let observationsRecorded = 0;

  do {
    batchNumber++;
    observationResult = collectDynamicObservationsFullBatch_({
      action: 'collect_dynamic_observations_full_batch',
      cycleId: cycleId,
      cycleIdempotencyKey: idempotencyKey + ':CYCLE',
      operationId: operationId + ':MNT013:B' + pad2_(batchNumber),
      idempotencyKey: idempotencyKey + ':MNT013:B' + pad2_(batchNumber),
      source: source,
      scope: 'all',
      batchSize: batchSize
    });

    if (!observationResult || !observationResult.ok) {
      throw new Error('Full-population typed-verification MNT013 batch returned ok=false');
    }
    if (String(observationResult.cycleId || '') !== cycleId) {
      throw new Error('Full-population typed-verification MNT013 returned a different Cycle ID');
    }
    if (observationResult.commitApplied || observationResult.runtimeRebuildApplied ||
        observationResult.publicationApplied) {
      throw new Error('Full-population typed-verification observation batch violated dry-run safety');
    }

    observationsRecorded += Number(observationResult.observationsRecorded || 0);
    if (batchNumber > 100) {
      throw new Error('Full-population typed-verification exceeded safe batch limit');
    }
  } while (Number(observationResult.remaining || 0) > 0);

  if (!observationResult.collectionComplete) {
    throw new Error('Full-population typed-verification observation collection did not complete');
  }
  if (Number(observationResult.processed || 0) !== Number(observationResult.expectedPopulation || 0)) {
    throw new Error('Full-population typed-verification observation coverage mismatch: ' +
      observationResult.processed + ' != ' + observationResult.expectedPopulation);
  }

  const resolutionResult = resolveDynamicObservations_({
    action: 'resolve_dynamic_observations',
    sourceCycleId: cycleId,
    policyId: 'DRP003',
    operationId: operationId + ':MNT014',
    idempotencyKey: idempotencyKey + ':MNT014',
    source: source
  });

  if (!resolutionResult || !resolutionResult.ok) {
    throw new Error('Full-population typed-verification MNT014 returned ok=false');
  }
  if (resolutionResult.commitApplied || !resolutionResult.resolutionOnly) {
    throw new Error('Full-population typed-verification MNT014 violated resolution-only safety');
  }

  const completed = new Date();
  const result = {
    ok: true,
    action: 'run_typed_verification_full_population_dry_run_v221',
    helperVersion: NW.VERSION,
    repository: repository,
    cycleId: cycleId,
    operationId: operationId,
    idempotencyKey: idempotencyKey,
    dryRun: true,
    commitApplied: false,
    runtimeRebuildApplied: false,
    publicationApplied: false,
    batchSize: batchSize,
    batchesExecuted: batchNumber,
    observationSummary: {
      ok: true,
      maintenanceTask: 'MNT013',
      cycleId: cycleId,
      observationsRecorded: observationsRecorded,
      expectedPopulation: Number(observationResult.expectedPopulation || 0),
      processed: Number(observationResult.processed || 0),
      observed: Number(observationResult.observed || 0),
      outstanding: Number(observationResult.outstanding || 0),
      remaining: Number(observationResult.remaining || 0),
      collectionComplete: !!observationResult.collectionComplete
    },
    resolutionSummary: {
      ok: true,
      maintenanceTask: 'MNT014',
      sourceCycleId: cycleId,
      observationsRead: Number(resolutionResult.observationsRead || 0),
      resolutionsRecorded: Number(resolutionResult.resolutionsRecorded || 0),
      classifications: resolutionResult.classifications || {}
    },
    expectedPopulation: Number(resolutionResult.expectedPopulation || 0),
    reconciledPopulation: Number(resolutionResult.reconciledPopulation || 0),
    unaccounted: Number(resolutionResult.unaccounted || 0),
    coveragePercent: Number(resolutionResult.coveragePercent || 0),
    cycleStatus: String(resolutionResult.cycleStatus || ''),
    startedAt: formatDate_(started),
    completedAt: formatDate_(completed),
    durationSeconds: Math.round((completed.getTime() - started.getTime()) / 1000),
    replayed: false
  };

  appendAudit_(ss, 'Typed verification v2.2.3 full-population dry run completed',
    'Dynamic Refresh', cycleId,
    'Actor: Next Watch Helper | Operation ID: ' + operationId +
    ' | Batches: ' + batchNumber +
    ' | Expected: ' + result.expectedPopulation +
    ' | Observations: ' + result.observationSummary.observationsRecorded +
    ' | Resolutions: ' + result.resolutionSummary.resolutionsRecorded +
    ' | Coverage %: ' + result.coveragePercent +
    ' | Canonical commit: False | Runtime rebuild: False | Publication: False');

  return result;
}


function testTypedVerificationV221() {
  const result = runTypedVerificationFullPopulationDryRunV221_();
  const verification = verifyTypedVerificationV221Result_(result, true);
  const output = {
    ok: true,
    action: 'test_typed_verification_v221',
    helperVersion: NW.VERSION,
    cycleId: result.cycleId || '',
    dryRun: true,
    canonicalCommitApplied: !!result.commitApplied,
    runtimeRebuildApplied: !!result.runtimeRebuildApplied,
    publicationApplied: !!result.publicationApplied,
    verification: verification,
    result: result,
    completedAt: now_()
  };

  console.log(JSON.stringify(output, null, 2));
  return output;
}


/**
 * Validates the operator dry-run result against the v2.2.3 typed-verification
 * contract. Throws on any contract regression so Apps Script marks the manual
 * test as failed instead of requiring the operator to infer success from logs.
 */
function verifyTypedVerificationV221Result_(result, requireTypedExercise) {
  if (!result || result.ok === false) {
    throw new Error('Typed-verification dry run failed: ' + JSON.stringify(result));
  }
  if (String(result.helperVersion || '') !== String(NW.VERSION)) {
    throw new Error('Helper version mismatch in typed-verification dry run: ' +
      String(result.helperVersion || '') + ' != ' + NW.VERSION);
  }
  if (!result.dryRun) {
    throw new Error('Typed-verification operator test did not execute as a dry run');
  }
  if (result.commitApplied) {
    throw new Error('Typed-verification operator test unexpectedly applied a canonical commit');
  }
  if (result.runtimeRebuildApplied) {
    throw new Error('Typed-verification operator test unexpectedly rebuilt runtime views');
  }
  if (result.publicationApplied) {
    throw new Error('Typed-verification operator test unexpectedly applied publication');
  }

  const expectedPopulation = Number(result.expectedPopulation || 0);
  const reconciledPopulation = Number(result.reconciledPopulation || 0);
  const unaccounted = Number(result.unaccounted || 0);
  const coveragePercent = Number(result.coveragePercent || 0);
  if (!expectedPopulation || reconciledPopulation !== expectedPopulation || unaccounted !== 0 || coveragePercent < 100) {
    throw new Error('Typed-verification operator test did not cover the full population: expected=' +
      expectedPopulation + ', reconciled=' + reconciledPopulation + ', unaccounted=' +
      unaccounted + ', coverage=' + coveragePercent);
  }

  const summary = result.resolutionSummary || {};
  const counts = summary.classifications || {};
  const allowed = [
    'changed',
    'reverified',
    'unchangedCurrent',
    'expectedNoProvider',
    'providerVerificationPending',
    'identityResolutionRequired',
    'legacyOutstanding',
    'legacyExempted',
    'outstanding',
    'exempted'
  ];

  Object.keys(counts).forEach(function(key) {
    if (allowed.indexOf(key) < 0) {
      throw new Error('Unexpected typed-verification classification counter: ' + key);
    }
  });

  const expectedNoProvider = Number(counts.expectedNoProvider || 0);
  const providerPending = Number(counts.providerVerificationPending || 0);
  const identityRequired = Number(counts.identityResolutionRequired || 0);
  const legacyOutstanding = Number(counts.legacyOutstanding || 0);
  const outstanding = Number(counts.outstanding || 0);
  const exempted = Number(counts.exempted || 0);
  const legacyExempted = Number(counts.legacyExempted || 0);

  const typedExerciseCount = expectedNoProvider + providerPending + identityRequired;
  if (requireTypedExercise && typedExerciseCount <= 0) {
    throw new Error('Full-population test completed but did not exercise any typed verification branch; ' +
      'the implementation cannot be considered behaviorally verified against the current repository.');
  }

  const expectedOutstanding = providerPending + identityRequired + legacyOutstanding;
  if (outstanding !== expectedOutstanding) {
    throw new Error('Typed actionable-outstanding aggregation mismatch: ' +
      outstanding + ' != ' + expectedOutstanding);
  }

  const expectedExempted = expectedNoProvider + legacyExempted;
  if (exempted !== expectedExempted) {
    throw new Error('Expected-No-Provider exemption aggregation mismatch: ' +
      exempted + ' != ' + expectedExempted);
  }

  if (legacyOutstanding > 0) {
    throw new Error('Legacy Outstanding Verification classification is still being emitted: ' +
      legacyOutstanding + ' row(s)');
  }

  const ss = openRepository_();
  verifyRepository_(ss);
  const resolutions = table_(ss, NW.DYNAMIC_RESOLUTIONS).rows.filter(function(r) {
    return String(r['Cycle ID'] || '') === String(result.cycleId || '');
  });
  if (resolutions.length !== Number(summary.resolutionsRecorded || 0)) {
    throw new Error('Typed-verification resolution evidence count mismatch: ' +
      resolutions.length + ' != ' + Number(summary.resolutionsRecorded || 0));
  }

  const allowedRowClassifications = [
    'Changed',
    'Reverified',
    'Unchanged Current',
    'Expected No Provider',
    'Provider Verification Pending',
    'Identity Resolution Required',
    'Exempted'
  ];

  resolutions.forEach(function(r) {
    const classification = String(r.classification || r.Classification || '');
    if (classification && allowedRowClassifications.indexOf(classification) < 0) {
      throw new Error('Unexpected resolution classification: ' + classification);
    }

    if (['Expected No Provider', 'Provider Verification Pending',
         'Identity Resolution Required'].indexOf(classification) >= 0) {
      const preservation = r.preservationApplied !== undefined
        ? !!r.preservationApplied
        : truthy_(r['Preservation Applied']);
      const commitEligible = r.commitEligible !== undefined
        ? !!r.commitEligible
        : truthy_(r['Commit Eligible']);
      if (!preservation) {
        throw new Error(classification + ' did not preserve last verified state for ' +
          String(r.titleId || r['Title ID'] || 'unknown title'));
      }
      if (commitEligible) {
        throw new Error(classification + ' was incorrectly marked commit-eligible for ' +
          String(r.titleId || r['Title ID'] || 'unknown title'));
      }
    }
  });

  // Semantic guard for the DRP004 theatrical-window refinement: any row that
  // claims the governed theatrical-only exemption must be a movie, must be
  // Expected No Provider, and must explicitly cite the governed window.
  resolutions.forEach(function(r) {
    const reasonText = String(r.reason || r.Reason || '');
    if (reasonText.indexOf('governed ' + Number(NW.THEATRICAL_RELEASE_WINDOW_DAYS || 21) +
        '-day theatrical release window') >= 0) {
      const classification = String(r.classification || r.Classification || '');
      const mediaType = String(r.mediaType || r['Media Type'] || '').toLowerCase();
      if (classification !== 'Expected No Provider' || mediaType !== 'movie') {
        throw new Error('Theatrical-window applicability contract failed for ' +
          String(r.titleId || r['Title ID'] || 'unknown title'));
      }
    }
  });

  return {
    passed: true,
    helperVersion: NW.VERSION,
    cycleId: result.cycleId || '',
    expectedPopulation: expectedPopulation,
    reconciledPopulation: reconciledPopulation,
    coveragePercent: coveragePercent,
    fullPopulationVerified: true,
    observationsRecorded: result.observationSummary
      ? Number(result.observationSummary.observationsRecorded || 0)
      : 0,
    resolutionsRecorded: Number(summary.resolutionsRecorded || 0),
    typedExerciseCount: typedExerciseCount,
    expectedNoProvider: expectedNoProvider,
    providerVerificationPending: providerPending,
    identityResolutionRequired: identityRequired,
    actionableOutstanding: outstanding,
    legacyOutstanding: legacyOutstanding,
    preservationContractChecked: true,
    commitSafetyChecked: true,
    message: 'PASS — v2.2.3 full-population typed-verification contract verified; typed branches were exercised and no canonical commit, runtime rebuild, or publication was applied.'
  };
}


// Current-version operator alias. The underlying V221-named implementation is
// retained to avoid breaking existing Apps Script bookmarks and deployments.
function testTypedVerificationV222() {
  return testTypedVerificationV221();
}

// Backward-compatible operator alias retained for deployments/bookmarks from v2.2.0.
function testTypedVerificationV220() {
  return testTypedVerificationV221();
}
