import type { components } from '../../../../contracts/api';
import type { paths } from '../../../../contracts/api';
import createClient from 'openapi-fetch';

export type Dashboard = components['schemas']['Dashboard'];
export type Item = components['schemas']['Item'];
export type Job = components['schemas']['Job'];
export type Settings = components['schemas']['Settings'];
export type Preferences = components['schemas']['PreferencesView'];
export type Feedback = components['schemas']['FeedbackCommand'];
export type Application = components['schemas']['ApplicationView'];
export type ApplicationFields = Pick<Application, 'title' | 'contact' | 'url' | 'applied_on' | 'stage' | 'follow_up_on' | 'note'>;
export type ApplicationCreate = components['schemas']['ApplicationCreate'];
export type ApplicationSummary = components['schemas']['ApplicationSummary'];

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const api = createClient<paths>({ baseUrl: '/api' });

export function result<T>({ data, error, response }: {
  data?: T; error?: components['schemas']['Error']; response: Response;
}): T {
  if (!response.ok || data === undefined) throw new ApiError(response.status, error?.error || '服務暫時無法使用');
  return data;
}

export const getDashboard = async () => result(await api.GET('/dashboard', { cache: 'no-store' }));
export const getOpportunity = async (key: string) => result(await api.GET('/opportunities/{key}', { params: { path: { key } }, cache: 'no-store' }));
export const updatePreferences = async (body: Preferences) => result(await api.POST('/preferences', { body }));
export const updateFeedback = async (key: string, body: Feedback) =>
  result(await api.POST('/feedback/{key}', { params: { path: { key } }, body }));
export const getApplications = async (query: { stage?: string; due?: boolean; offset?: number; limit?: number;client_id?:string } = {}) =>
  result(await api.GET('/applications', { params: { query }, cache: 'no-store' }));
export const getApplicationSummary = async () => result(await api.GET('/applications/summary', { cache: 'no-store' }));
export const getApplication = async (key: string) => result(await api.GET('/applications/{key}', { params: { path: { key } }, cache:'no-store' }));
export const createApplication = async (body: ApplicationCreate) => result(await api.POST('/applications', { body }));
export const updateApplication = async (key: string, body: components['schemas']['ApplicationUpdate']) =>
  result(await api.PATCH('/applications/{key}', { params: { path: { key } }, body }));
export const deleteApplication = async (key: string, revision: number) =>
  result(await api.DELETE('/applications/{key}', { params: { path: { key } }, body: { revision } }));
