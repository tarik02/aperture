import * as Api from "@aperture/api-schema";

// Resources described by api/openapi.yaml, under the names the app uses.

export type PageMeta = Api.PageMeta;
export type Tenant = Api.Tenant;
export type User = Api.User;
export type UserInvitation = Api.UserInvitation;
export type TenantMembership = Api.TenantMembership;
export type AuthMeResponse = Api.AuthMe;
export type AuthMePrincipal = Api.Principal;
export type AuthMeTenant = Api.Tenant;
export type ResourceMode = Api.ResourceMode;
export type ResourceGrant = Api.ResourceGrant;
export type Scope = Api.Scope;
export type TenantScope = Api.TenantScope;
export type Session = Api.Session;
export type SessionMedia = Api.SessionMedia;
export type IceServer = Api.IceServer;
export const SessionStatus = Api.SessionStatus;
export type SessionStatus = Api.SessionStatus;
export type Snapshot = Api.Snapshot;
export type ApiToken = Api.Token;
export type TenantsPage = Api.TenantPage;
export type UsersPage = Api.UserPage;
export type SessionsPage = Api.SessionPage;
export type SessionsBulkResponse = Api.SessionBulkResponse;
export type SnapshotsPage = Api.SnapshotPage;
export type TokensPage = Api.TokenPage;
export type BrowserChannel = Api.BrowserChannel;
export type BrowserChannelsResponse = Api.BrowserChannels;
export type ResourceEvent = Api.Event;
export type EventsPage = Api.EventPage;
export type CreateSessionResponse = Api.CreateSessionResult;
export type SessionMutationResponse = Api.SessionMutation;
export type SnapshotMutationResponse = Api.SnapshotMutation;
export type PromoteSessionResponse = Api.SnapshotMutation;
export type CreateTokenResponse = Api.CreateTokenResponse;
