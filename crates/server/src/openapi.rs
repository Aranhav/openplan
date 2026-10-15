use utoipa::{
    Modify, OpenApi,
    openapi::{
        self, ContentBuilder, Ref, RefOr, ResponseBuilder,
        path::Operation,
        response::Response,
        security::{ApiKey, ApiKeyValue, SecurityRequirement, SecurityScheme},
    },
};

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
    cells_api::{
        CellChangeDto, CellEditDto, ChangedByDto, ReadCellsRequest, ReadCellsResponse, ValueDto,
        WriteCellsRequest, WriteCellsResponse,
    },
    error::Problem,
    models::{Calendar, CreateModelRequest, ModelDto, ModelMode, UpdateModelRequest},
    modules_api::{
        CheckFormulaRequest, CheckFormulaResponse, CompletionDto, CompletionKindDto,
        CreateLineItemRequest, CreateModuleRequest, FunctionDto, ReorderLineItemsRequest,
        UpdateLineItemRequest, UpdateModuleRequest,
    },
    structure_api::{
        CalendarDto, CreateItemsRequest, CreateListRequest, CreateSubsetRequest,
        CreateTimeRangeRequest, DeleteItemsRequest, ItemDto, ItemInput, ListDto, SubsetDto,
        TimeRangeDto, UpdateItemRequest, UpdateListRequest, UpdateSubsetRequest, VersionDto,
        VersionRequest,
    },
    structure_dto::{
        AxisDto, FormatDto, LineItemDto, ModuleDto, NegativeStyleDto, NumberUnitDto,
        StructureCalendarDto, StructureDto, StructureItemDto, StructureListDto, StructureSubsetDto,
        StructureTimeRangeDto, StructureVersionDto, SummaryMethodDto, TimeLevelDto, TimeScaleDto,
        ValueTypeDto, VersionsScopeDto,
    },
    users::{CreateUserRequest, UpdateUserRequest, UserDto},
    workspaces::{
        AddMemberRequest, ChangeRoleRequest, MemberDto, WorkspaceNameRequest, WorkspaceSummary,
    },
};

const SESSION_SCHEME: &str = "session_cookie";
const CSRF_SCHEME: &str = "csrf_header";
const CSRF_REJECTED: &str = "CsrfRejected";
const PROBLEM_JSON: &str = "application/problem+json";
const CSRF_NOTE: &str =
    "It is also returned when the CSRF token is missing or invalid (auth.csrf).";

/// Routes that work without a session.
const PUBLIC_PATHS: [&str; 5] = [
    "/api/health",
    "/api/v1/setup/status",
    "/api/v1/setup",
    "/api/v1/auth/login",
    "/api/v1/auth/logout",
];

/// Routes outside the CSRF check; see `auth::routes::session_router`.
const CSRF_EXEMPT_PATHS: [&str; 3] = ["/api/v1/setup", "/api/v1/auth/login", "/api/v1/auth/logout"];

#[derive(OpenApi)]
#[openapi(
    info(title = "OpenPlan API"),
    modifiers(&Conventions),
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
        crate::models::list_models,
        crate::models::create_model,
        crate::models::get_model,
        crate::models::update_model,
        crate::models::delete_model,
        crate::structure_api::get_structure,
        crate::structure_api::update_calendar,
        crate::structure_api::create_list,
        crate::structure_api::update_list,
        crate::structure_api::delete_list,
        crate::structure_api::list_items,
        crate::structure_api::create_items,
        crate::structure_api::update_item,
        crate::structure_api::delete_items,
        crate::structure_api::create_subset,
        crate::structure_api::update_subset,
        crate::structure_api::delete_subset,
        crate::structure_api::create_version,
        crate::structure_api::upsert_version,
        crate::structure_api::delete_version,
        crate::structure_api::create_time_range,
        crate::structure_api::delete_time_range,
        crate::modules_api::create_module,
        crate::modules_api::update_module,
        crate::modules_api::delete_module,
        crate::modules_api::create_line_item,
        crate::modules_api::update_line_item,
        crate::modules_api::delete_line_item,
        crate::modules_api::reorder_line_items,
        crate::modules_api::check_formula,
        crate::modules_api::completions,
        crate::modules_api::functions_reference,
        crate::cells_api::write_cells,
        crate::cells_api::read_cells,
        crate::cells_api::cell_history,
    ),
    components(schemas(
        Problem,
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
        Calendar,
        ModelMode,
        ModelDto,
        CreateModelRequest,
        UpdateModelRequest,
        ListDto,
        CreateListRequest,
        UpdateListRequest,
        ItemDto,
        ItemInput,
        CreateItemsRequest,
        UpdateItemRequest,
        DeleteItemsRequest,
        SubsetDto,
        CreateSubsetRequest,
        UpdateSubsetRequest,
        VersionDto,
        VersionRequest,
        CalendarDto,
        TimeRangeDto,
        CreateTimeRangeRequest,
        StructureDto,
        StructureCalendarDto,
        StructureListDto,
        StructureItemDto,
        StructureSubsetDto,
        StructureVersionDto,
        StructureTimeRangeDto,
        ModuleDto,
        LineItemDto,
        AxisDto,
        TimeLevelDto,
        FormatDto,
        NumberUnitDto,
        NegativeStyleDto,
        SummaryMethodDto,
        TimeScaleDto,
        VersionsScopeDto,
        ValueTypeDto,
        CreateModuleRequest,
        UpdateModuleRequest,
        CreateLineItemRequest,
        UpdateLineItemRequest,
        ReorderLineItemsRequest,
        CheckFormulaRequest,
        CheckFormulaResponse,
        CompletionDto,
        CompletionKindDto,
        FunctionDto,
        ValueDto,
        CellEditDto,
        WriteCellsRequest,
        WriteCellsResponse,
        ReadCellsRequest,
        ReadCellsResponse,
        ChangedByDto,
        CellChangeDto,
    ))
)]
pub struct ApiDoc;

pub fn openapi_json() -> String {
    ApiDoc::openapi()
        .to_pretty_json()
        .expect("the OpenAPI document serializes to JSON")
}

/// Describes what every route has in common instead of repeating it on each
/// one: the sign-in and CSRF requirements, the CSRF rejection and the body of
/// error responses.
struct Conventions;

impl Modify for Conventions {
    fn modify(&self, openapi: &mut openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            SESSION_SCHEME,
            SecurityScheme::ApiKey(ApiKey::Cookie(ApiKeyValue::with_description(
                "op_session",
                "Set by signing in. Browsers send it on their own.",
            ))),
        );
        components.add_security_scheme(
            CSRF_SCHEME,
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::with_description(
                "X-OpenPlan-CSRF",
                "The value of the op_csrf cookie. Required on POST, PUT, PATCH and DELETE \
                 requests that carry a session cookie, except sign-in, setup and sign-out.",
            ))),
        );
        components.responses.insert(
            CSRF_REJECTED.to_string(),
            RefOr::T(problem_response(
                "The CSRF token is missing or invalid (auth.csrf)",
            )),
        );

        for (path, item) in &mut openapi.paths.paths {
            let operations = [
                (false, item.get.as_mut()),
                (true, item.put.as_mut()),
                (true, item.post.as_mut()),
                (true, item.delete.as_mut()),
                (true, item.patch.as_mut()),
            ];
            for (mutating, operation) in operations {
                if let Some(operation) = operation {
                    describe(operation, path, mutating);
                }
            }
        }
    }
}

fn describe(operation: &mut Operation, path: &str, mutating: bool) {
    let needs_csrf = mutating && !CSRF_EXEMPT_PATHS.contains(&path);
    if needs_csrf {
        match operation.responses.responses.get_mut("403") {
            Some(RefOr::T(forbidden)) => {
                forbidden.description = format!("{}. {CSRF_NOTE}", forbidden.description);
            }
            _ => {
                operation.responses.responses.insert(
                    "403".to_string(),
                    RefOr::Ref(Ref::from_response_name(CSRF_REJECTED)),
                );
            }
        }
    }
    for (status, response) in &mut operation.responses.responses {
        let is_error = status.parse::<u16>().is_ok_and(|status| status >= 400);
        if let (true, RefOr::T(response)) = (is_error, response)
            && response.content.is_empty()
        {
            add_problem_body(response);
        }
    }
    if !PUBLIC_PATHS.contains(&path) {
        let mut requirement = SecurityRequirement::new(SESSION_SCHEME, Vec::<String>::new());
        if needs_csrf {
            requirement = requirement.add(CSRF_SCHEME, Vec::<String>::new());
        }
        operation.security = Some(vec![requirement]);
    }
}

fn add_problem_body(response: &mut Response) {
    response.content.insert(
        PROBLEM_JSON.to_string(),
        ContentBuilder::new()
            .schema(Some(Ref::from_schema_name("Problem")))
            .build(),
    );
}

fn problem_response(description: &str) -> Response {
    let mut response = ResponseBuilder::new().description(description).build();
    add_problem_body(&mut response);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CSRF_EXEMPT: [&str; 3] = ["/api/v1/setup", "/api/v1/auth/login", "/api/v1/auth/logout"];
    const PUBLIC: [&str; 5] = [
        "/api/health",
        "/api/v1/setup/status",
        "/api/v1/setup",
        "/api/v1/auth/login",
        "/api/v1/auth/logout",
    ];

    fn document() -> Value {
        serde_json::to_value(ApiDoc::openapi()).unwrap()
    }

    /// Every operation with its path and lowercase method.
    fn operations(document: &Value) -> Vec<(String, String, &Value)> {
        let mut found = Vec::new();
        for (path, item) in document["paths"].as_object().unwrap() {
            for (method, operation) in item.as_object().unwrap() {
                found.push((path.clone(), method.clone(), operation));
            }
        }
        found
    }

    fn is_mutating(method: &str) -> bool {
        matches!(method, "post" | "put" | "patch" | "delete")
    }

    #[test]
    fn health_has_its_own_tag() {
        assert_eq!(
            document()["paths"]["/api/health"]["get"]["tags"],
            serde_json::json!(["health"])
        );
    }

    #[test]
    fn session_cookie_and_csrf_header_are_security_schemes() {
        let schemes = &document()["components"]["securitySchemes"];

        assert_eq!(schemes["session_cookie"]["type"], "apiKey");
        assert_eq!(schemes["session_cookie"]["in"], "cookie");
        assert_eq!(schemes["session_cookie"]["name"], "op_session");
        assert_eq!(schemes["csrf_header"]["type"], "apiKey");
        assert_eq!(schemes["csrf_header"]["in"], "header");
        assert_eq!(schemes["csrf_header"]["name"], "X-OpenPlan-CSRF");
    }

    #[test]
    fn routes_that_need_a_session_say_so_and_mutating_ones_also_need_the_csrf_header() {
        let document = document();

        for (path, method, operation) in operations(&document) {
            let name = format!("{method} {path}");
            if PUBLIC.contains(&path.as_str()) {
                assert!(operation.get("security").is_none(), "{name}");
                continue;
            }
            let required = if is_mutating(&method) {
                vec!["csrf_header", "session_cookie"]
            } else {
                vec!["session_cookie"]
            };
            let security = operation["security"].as_array().unwrap_or_else(|| {
                panic!("{name} does not declare security");
            });
            assert_eq!(security.len(), 1, "{name}");
            let mut declared: Vec<&str> = security[0]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            declared.sort_unstable();
            assert_eq!(declared, required, "{name}");
        }
    }

    #[test]
    fn problem_schema_describes_error_bodies() {
        let problem = &document()["components"]["schemas"]["Problem"];

        let mut properties: Vec<&str> = problem["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        properties.sort_unstable();
        assert_eq!(
            properties,
            [
                "code",
                "detail",
                "errors",
                "formula_errors",
                "status",
                "title",
                "type"
            ]
        );
        let mut required: Vec<&str> = problem["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap())
            .collect();
        required.sort_unstable();
        assert_eq!(required, ["code", "detail", "status", "title", "type"]);
        assert!(document()["components"]["schemas"]["FieldError"].is_object());
        assert!(document()["components"]["schemas"]["FormulaProblem"].is_object());
    }

    #[test]
    fn every_error_response_has_a_problem_body() {
        let document = document();

        for (path, method, operation) in operations(&document) {
            for (status, response) in operation["responses"].as_object().unwrap() {
                if status.parse::<u16>().unwrap() < 400 {
                    continue;
                }
                let response = resolve(&document, response);
                assert_eq!(
                    response["content"]["application/problem+json"]["schema"]["$ref"],
                    "#/components/schemas/Problem",
                    "{status} of {method} {path}"
                );
            }
        }
    }

    #[test]
    fn mutating_routes_document_the_csrf_rejection() {
        let document = document();

        for (path, method, operation) in operations(&document) {
            if !is_mutating(&method) {
                continue;
            }
            let forbidden = resolve(&document, &operation["responses"]["403"]);
            let documents_csrf = forbidden["description"]
                .as_str()
                .is_some_and(|description| description.contains("auth.csrf"));
            assert_eq!(
                documents_csrf,
                !CSRF_EXEMPT.contains(&path.as_str()),
                "{method} {path}"
            );
        }
    }

    #[test]
    fn the_csrf_rejection_is_a_shared_response() {
        let shared = &document()["components"]["responses"]["CsrfRejected"];

        assert!(
            shared["description"]
                .as_str()
                .unwrap()
                .contains("auth.csrf")
        );
        assert_eq!(
            document()["paths"]["/api/v1/auth/me"]["patch"]["responses"]["403"]["$ref"],
            "#/components/responses/CsrfRejected"
        );
    }

    #[test]
    fn changing_the_password_documents_its_rate_limit() {
        let response = &document()["paths"]["/api/v1/auth/me/password"]["post"]["responses"]["429"];

        assert!(
            response["description"]
                .as_str()
                .unwrap()
                .contains("auth.rate_limited")
        );
    }

    fn resolve<'a>(document: &'a Value, response: &'a Value) -> &'a Value {
        match response["$ref"].as_str() {
            Some(reference) => document
                .pointer(reference.strip_prefix('#').unwrap())
                .expect("the reference resolves"),
            None => response,
        }
    }
}
