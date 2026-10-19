/**
 * shared/contracts/index.js
 * 统一数据契约、操作名、会话状态与错误码 (依据 project.md 第四节)
 */

export const SESSION_STATUS = {
  GUEST: 'guest',
  RESTORING: 'restoring',
  AUTHENTICATED: 'authenticated',
  OFFLINE: 'offline',
  REAUTH_REQUIRED: 'reauth_required',
  LOGGING_OUT: 'logging_out'
}

export const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  SESSION_CHANGED: 'SESSION_CHANGED',
  NETWORK_UNAVAILABLE: 'NETWORK_UNAVAILABLE',
  PAGE_TIMEOUT: 'PAGE_TIMEOUT',
  PAGE_CONTRACT_CHANGED: 'PAGE_CONTRACT_CHANGED',
  RATE_LIMITED: 'RATE_LIMITED',
  PAGINATION_STALLED: 'PAGINATION_STALLED',
  STAR_STATE_UNCERTAIN: 'STAR_STATE_UNCERTAIN',
  LOCAL_STORAGE_FAILED: 'LOCAL_STORAGE_FAILED',
  INPUT_CHANGED: 'INPUT_CHANGED'
}

export const OPERATIONS = {
  APP_INITIALIZE: 'app.initialize',
  SESSION_BEGIN_LOGIN: 'session.beginLogin',
  SESSION_GET_LOGIN_TASK: 'session.getLoginTask',
  SESSION_CANCEL_LOGIN: 'session.cancelLogin',
  SESSION_RESTORE: 'session.restore',
  SESSION_LOGOUT: 'session.logout',
  ACCOUNT_READ_SNAPSHOT: 'account.readSnapshot',
  ACCOUNT_SYNC: 'account.sync',
  TASKS_READ: 'tasks.read',
  TASKS_CANCEL: 'tasks.cancel',
  REPOSITORIES_LIST: 'repositories.list',
  STARS_READ_STATE: 'stars.readState',
  STARS_SET: 'stars.set',
  HISTORY_RECORD: 'history.record',
  HISTORY_LIST: 'history.list',
  HISTORY_DELETE: 'history.delete',
  HISTORY_CLEAR: 'history.clear',
  ACCOUNT_SAVE_PREFERENCES: 'account.savePreferences',
  ACCOUNT_FORGET_LOCAL_DATA: 'account.forgetLocalData',
  DISCOVERY_REFRESH: 'discovery.refresh',
  DISCOVERY_READ: 'discovery.read',
  RECOMMENDATION_CREATE_SNAPSHOT: 'recommendation.createSnapshot',
  RECOMMENDATION_COMMIT: 'recommendation.commit',
  RECOMMENDATION_LIST: 'recommendation.list',
  RECOMMENDATION_FEEDBACK: 'recommendation.feedback',
  REPOSITORY_OPEN: 'repository.open'
}

export const MODEL_VERSION = 'content-v1'
export const PARSER_VERSION = 'content-v1'

export function createSuccessResult(data, contextId = '') {
  return { ok: true, data, contextId }
}

export function createErrorResult(code, message, extra = {}, contextId = '') {
  return {
    ok: false,
    error: {
      code,
      message,
      ...extra
    },
    contextId
  }
}
