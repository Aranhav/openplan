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
    fn ids_serialize_as_bare_uuid_strings() {
        let id = ItemId::new();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{}\"", id.0));
        assert_eq!(serde_json::from_str::<ItemId>(&json).unwrap(), id);
    }
}
