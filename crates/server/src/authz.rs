use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    auth::CurrentUser,
    error::{AppError, AppResult},
};

/// A member's role in a workspace, from least to most privileged.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, ToSchema, sqlx::Type,
)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum WorkspaceRole {
    Viewer,
    Planner,
    Builder,
    Admin,
}

/// `Forbidden` unless the caller is an instance admin.
pub fn require_instance_admin(user: &CurrentUser) -> AppResult<()> {
    if user.is_instance_admin {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

/// The caller's role in a workspace. Instance admins are admins of every
/// workspace; everyone else needs a membership. A workspace the caller cannot
/// see is `NotFound`, so its existence is not revealed.
pub async fn workspace_role(
    db: &PgPool,
    user: &CurrentUser,
    workspace_id: Uuid,
) -> AppResult<WorkspaceRole> {
    if user.is_instance_admin {
        let exists: bool =
            sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM workspaces WHERE id = $1)")
                .bind(workspace_id)
                .fetch_one(db)
                .await?;
        return if exists {
            Ok(WorkspaceRole::Admin)
        } else {
            Err(AppError::NotFound)
        };
    }
    sqlx::query_scalar::<_, WorkspaceRole>(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    )
    .bind(workspace_id)
    .bind(user.id)
    .fetch_optional(db)
    .await?
    .ok_or(AppError::NotFound)
}

/// Like [`workspace_role`], but `Forbidden` when the role is below `min`.
pub async fn require_workspace_role(
    db: &PgPool,
    user: &CurrentUser,
    workspace_id: Uuid,
    min: WorkspaceRole,
) -> AppResult<WorkspaceRole> {
    let role = workspace_role(db, user, workspace_id).await?;
    if role < min {
        return Err(AppError::Forbidden);
    }
    Ok(role)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roles_are_ordered_from_viewer_to_admin() {
        assert!(WorkspaceRole::Viewer < WorkspaceRole::Planner);
        assert!(WorkspaceRole::Planner < WorkspaceRole::Builder);
        assert!(WorkspaceRole::Builder < WorkspaceRole::Admin);
    }

    #[test]
    fn roles_serialize_as_lowercase_names() {
        assert_eq!(
            serde_json::to_string(&WorkspaceRole::Planner).unwrap(),
            "\"planner\""
        );
        assert_eq!(
            serde_json::from_str::<WorkspaceRole>("\"admin\"").unwrap(),
            WorkspaceRole::Admin
        );
        assert!(serde_json::from_str::<WorkspaceRole>("\"owner\"").is_err());
    }
}
