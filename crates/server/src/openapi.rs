use utoipa::OpenApi;

use crate::{
    app::HealthResponse,
    auth::{
        CurrentUser,
        routes::{
            ChangePasswordRequest, LoginRequest, LoginResponse, MeResponse, SetupRequest,
            SetupResponse, SetupStatus, UpdateProfileRequest,
        },
    },
    authz::WorkspaceRole,
    users::{CreateUserRequest, UpdateUserRequest, UserDto},
    workspaces::{
        AddMemberRequest, ChangeRoleRequest, MemberDto, WorkspaceNameRequest, WorkspaceSummary,
    },
};

#[derive(OpenApi)]
#[openapi(
    info(title = "OpenPlan API"),
    paths(
        crate::app::health,
        crate::auth::routes::setup_status,
        crate::auth::routes::setup,
        crate::auth::routes::login,
        crate::auth::routes::logout,
        crate::auth::routes::me,
        crate::auth::routes::update_me,
        crate::auth::routes::change_password,
        crate::users::list_users,
        crate::users::create_user,
        crate::users::update_user,
        crate::workspaces::list_workspaces,
        crate::workspaces::create_workspace,
        crate::workspaces::rename_workspace,
        crate::workspaces::delete_workspace,
        crate::workspaces::list_members,
        crate::workspaces::add_member,
        crate::workspaces::change_member_role,
        crate::workspaces::remove_member,
    ),
    components(schemas(
        HealthResponse,
        CurrentUser,
        SetupStatus,
        SetupRequest,
        SetupResponse,
        LoginRequest,
        LoginResponse,
        MeResponse,
        UpdateProfileRequest,
        ChangePasswordRequest,
        UserDto,
        CreateUserRequest,
        UpdateUserRequest,
        WorkspaceRole,
        WorkspaceSummary,
        MemberDto,
        WorkspaceNameRequest,
        AddMemberRequest,
        ChangeRoleRequest,
    ))
)]
pub struct ApiDoc;

pub fn openapi_json() -> String {
    ApiDoc::openapi()
        .to_pretty_json()
        .expect("the OpenAPI document serializes to JSON")
}
