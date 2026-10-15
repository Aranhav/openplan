use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! define_ids {
    ($($(#[$doc:meta])* $name:ident),+ $(,)?) => {$(
        $(#[$doc])*
        #[derive(Copy, Clone, Eq, PartialEq, Hash, Ord, PartialOrd, Debug, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            /// Generates a fresh time-ordered (UUID v7) identifier.
            #[allow(clippy::new_without_default)]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }
        }
    )+};
}

define_ids! {
    /// Identifies a list.
    ListId,
    /// Identifies an item of a list.
    ItemId,
    /// Identifies a subset of a list.
    SubsetId,
    /// Identifies a module.
    ModuleId,
    /// Identifies a line item of a module.
    LineItemId,
    /// Identifies a version.
    VersionId,
    /// Identifies a named time range.
    TimeRangeId,
}

impl ListId {
    /// The id of the built-in Versions dimension, which formulas see as a list whose items
    /// are the versions: `ITEM(Versions)` is an item of it and so is `Versions.Budget`.
    ///
    /// No user list has this id, and it is not a UUID v7, which every generated id is.
    pub const VERSIONS: ListId = ListId(Uuid::from_u128(1));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_ids_are_distinct_uuid_v7() {
        let a = ListId::new();
        let b = ListId::new();
        assert_ne!(a, b);
        assert_eq!(a.0.get_version_num(), 7);
    }

    #[test]
    fn the_versions_list_id_is_never_generated() {
        assert_ne!(ListId::VERSIONS.0.get_version_num(), 7);
        assert_ne!(ListId::new(), ListId::VERSIONS);
    }

    #[test]
    fn ids_serialize_as_bare_uuid_strings() {
        let id = ItemId::new();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{}\"", id.0));
        assert_eq!(serde_json::from_str::<ItemId>(&json).unwrap(), id);
    }
}
