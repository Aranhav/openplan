use utoipa::OpenApi;

use crate::{
    app::HealthResponse,
    auth::{
        CurrentUser,
        routes::{
            LoginRequest, LoginResponse, MeResponse, SetupRequest, SetupResponse, SetupStatus,
            WorkspaceMembership, WorkspaceSummary,
        },
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
    ))
)]
pub struct ApiDoc;

pub fn openapi_json() -> String {
    ApiDoc::openapi()
        .to_pretty_json()
        .expect("the OpenAPI document serializes to JSON")
}
