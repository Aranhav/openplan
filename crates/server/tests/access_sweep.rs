//! Who may call what, checked for every operation of the OpenAPI document, so that a route added
//! later is held to the same rules. Without a session an operation is a 401. A caller who is not a
//! member of a model's workspace finds no model: 404. A viewer of it may read but not change.

mod common;

use axum::http::{Method, StatusCode};
use common::{
    TestApp, assert_problem, change_rows, create_member, create_user, plan, sign_in_beside,
};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

/// The POSTs under a model that only read it, which a viewer may make.
const READS_BY_POST: [&str; 1] = ["/api/v1/models/{id}/cells/read"];

/// A value that fits `schema`, with the properties it requires and no more: the smallest request
/// that a route accepts as well formed, which is what it reads before it looks at who is asking.
fn example(document: &Value, schema: &Value) -> Value {
    if let Some(reference) = schema["$ref"].as_str() {
        let name = reference.rsplit('/').next().unwrap();
        return example(document, &document["components"]["schemas"][name]);
    }
    if let Some(variant) = schema["oneOf"].get(0) {
        return example(document, variant);
    }
    let kind = match &schema["type"] {
        Value::String(kind) => kind.as_str(),
        Value::Array(kinds) => kinds
            .iter()
            .filter_map(Value::as_str)
            .find(|k| *k != "null")
            .unwrap(),
        other => panic!("no type in the schema {other}"),
    };
    match kind {
        "string" if schema["format"] == "uuid" => Value::from(Uuid::now_v7().to_string()),
        "string" => Value::from("x"),
        "integer" | "number" => Value::from(1),
        "boolean" => Value::from(false),
        "array" => Value::Array(Vec::new()),
        "object" => schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|name| {
                let name = name.as_str().unwrap();
                (
                    name.to_string(),
                    example(document, &schema["properties"][name]),
                )
            })
            .collect::<serde_json::Map<_, _>>()
            .into(),
        other => panic!("no example of the type {other}"),
    }
}

/// An operation of the document, ready to send as the model `model`.
struct Call {
    method: Method,
    /// The path as the document writes it, with `{id}` for the model.
    template: String,
    /// The path to send, with the query the operation requires.
    uri: String,
    body: Option<Value>,
    /// Whether the operation is a change of the model: it is not a GET and not a read by POST.
    changes_model: bool,
}

fn calls(document: &Value, model: &str) -> Vec<Call> {
    let mut calls = Vec::new();
    for (template, item) in document["paths"].as_object().unwrap() {
        for (method, operation) in item.as_object().unwrap() {
            // Only the operations behind a session.
            if operation["security"].as_array().is_none_or(Vec::is_empty) {
                continue;
            }
            let mut uri = template.replace("{id}", model);
            while let Some(start) = uri.find('{') {
                let end = uri[start..].find('}').unwrap() + start;
                uri.replace_range(start..=end, &Uuid::now_v7().to_string());
            }
            let query: Vec<String> = operation["parameters"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|parameter| parameter["in"] == "query" && parameter["required"] == true)
                .map(|parameter| {
                    let value = example(document, &parameter["schema"]);
                    format!(
                        "{}={}",
                        parameter["name"].as_str().unwrap(),
                        value.as_str().unwrap()
                    )
                })
                .collect();
            if !query.is_empty() {
                uri = format!("{uri}?{}", query.join("&"));
            }
            let body = operation["requestBody"]["content"]["application/json"]["schema"]
                .as_object()
                .map(|schema| example(document, &Value::Object(schema.clone())));
            let method = Method::from_bytes(method.to_uppercase().as_bytes()).unwrap();
            calls.push(Call {
                changes_model: method != Method::GET && !READS_BY_POST.contains(&template.as_str()),
                method,
                template: template.clone(),
                uri,
                body,
            });
        }
    }
    calls
}

#[sqlx::test(migrator = "openplan_server::db::MIGRATOR")]
async fn every_operation_holds_to_who_may_call_it(pool: PgPool) {
    let (mut admin, workspace, model) = plan(&pool).await;
    create_member(
        &mut admin,
        &workspace,
        "vera@acme.com",
        "Vera Viewer",
        "viewer",
    )
    .await;
    create_user(&mut admin, "olga@acme.com", "Olga Outsider").await;
    let mut viewer = sign_in_beside(&admin, "vera@acme.com").await;
    let mut outsider = sign_in_beside(&admin, "olga@acme.com").await;
    let mut anonymous = TestApp::new(pool.clone());
    let document = admin.get("/api/openapi.json").await.json;
    let calls = calls(&document, &model);
    let rows = change_rows(&pool, &model).await;
    let mut under_a_model = 0;

    for call in &calls {
        let Call {
            method,
            template,
            uri,
            body,
            changes_model,
        } = call;
        let what = format!("{method} {template}");

        let response = anonymous.request(method.clone(), uri, body.clone()).await;
        assert_problem(&response, StatusCode::UNAUTHORIZED, "auth.unauthenticated");

        if !template.starts_with("/api/v1/models/{id}") {
            continue;
        }
        under_a_model += 1;
        let response = outsider.request(method.clone(), uri, body.clone()).await;
        assert_eq!(
            response.status,
            StatusCode::NOT_FOUND,
            "{what}: {}",
            response.text
        );
        assert_eq!(response.json["code"], "not_found", "{what}");

        let response = viewer.request(method.clone(), uri, body.clone()).await;
        if *changes_model {
            assert_eq!(
                response.status,
                StatusCode::FORBIDDEN,
                "{what}: {}",
                response.text
            );
            assert_eq!(response.json["code"], "auth.forbidden", "{what}");
        } else {
            assert_ne!(
                response.status,
                StatusCode::FORBIDDEN,
                "{what}: {}",
                response.text
            );
        }
    }

    assert!(
        under_a_model >= 30,
        "only {under_a_model} operations under a model were swept"
    );
    assert_eq!(
        change_rows(&pool, &model).await,
        rows,
        "a refused call changed the model"
    );
    let found = admin.get(&format!("/api/v1/models/{model}")).await;
    assert_eq!(found.status, StatusCode::OK, "{}", found.text);
}
