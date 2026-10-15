use utoipa::OpenApi;

use crate::app::HealthResponse;

#[derive(OpenApi)]
#[openapi(
    info(title = "OpenPlan API"),
    paths(crate::app::health),
    components(schemas(HealthResponse))
)]
pub struct ApiDoc;

pub fn openapi_json() -> String {
    ApiDoc::openapi()
        .to_pretty_json()
        .expect("the OpenAPI document serializes to JSON")
}
