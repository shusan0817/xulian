/**
 * 前端类型出口
 *
 * 约定：
 * - 领域实体直接复用 `@shared/types`（前后端同一份定义，避免字段漂移）；
 * - 请求/响应 DTO 放 `./api`；纯 UI 类型放 `./ui`。
 */

export * from './api';
export * from './ui';
