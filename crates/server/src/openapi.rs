use utoipa::OpenApi;

use crate::{
    app::HealthResponse,
    auth::{
        CurrentUser,
        routes::{
            ChangePasswordRequest, LoginRequest, LoginResponse, MeResponse, SetupRequest,
            SetupResponse, SetupStatus, UpdateProfileRequest, WorkspaceMembership,
            WorkspaceSummary,
        },
    },
    users::{CreateUserRequest, UpdateUserRequest, UserDto},
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
    ),
    components(schemas(
        HealthResponse,
        CurrentUser,
        SetupStatus,
        SetupRequest,
        SetupResponse,
        WorkspaceSummary,
        LoginRequest,
        LoginResponse,
        WorkspaceMembership,
        MeResponse,
        UpdateProfileRequest,
        ChangePasswordRequest,
        UserDto,
        CreateUserRequest,
        UpdateUserRequest,
    ))
)]
pub struct ApiDoc;

pub fn openapi_json() -> String {
    ApiDoc::openapi()
        .to_pretty_json()
        .expect("the OpenAPI document serializes to JSON")
}
