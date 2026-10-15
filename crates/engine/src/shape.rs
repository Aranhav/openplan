use crate::calendar::TimeLevel;
use crate::ids::{ListId, SubsetId, TimeRangeId};

/// One dimension of a stored or computed cell grid.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Axis {
    List(ListId),
    Subset(SubsetId),
    /// A list reduced to its single top-level (total) item.
    ListTop(ListId),
    Time {
        level: TimeLevel,
        range: Option<TimeRangeId>,
    },
    Versions,
}

/// Row-major layout of a cell grid: the last axis varies fastest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shape {
    pub axes: Vec<Axis>,
    pub lens: Vec<u32>,
    pub strides: Vec<usize>,
}

impl Shape {
    pub fn new(axes: Vec<Axis>, lens: Vec<u32>) -> Shape {
        assert_eq!(axes.len(), lens.len(), "a shape needs one length per axis");
        let mut strides = vec![1; lens.len()];
        for pos in (0..lens.len().saturating_sub(1)).rev() {
            strides[pos] = strides[pos + 1] * lens[pos + 1] as usize;
        }
        Shape {
            axes,
            lens,
            strides,
        }
    }

    /// Number of cells; a shape without axes holds exactly one.
    pub fn size(&self) -> usize {
        self.lens.iter().map(|&len| len as usize).product()
    }

    /// Linear index of the cell at `coords`, one coordinate per axis.
    pub fn index(&self, coords: &[u32]) -> usize {
        debug_assert_eq!(coords.len(), self.lens.len());
        debug_assert!(coords.iter().zip(&self.lens).all(|(c, len)| c < len));
        coords
            .iter()
            .zip(&self.strides)
            .map(|(&coord, &stride)| coord as usize * stride)
            .sum()
    }

    /// Writes the per-axis coordinates of linear `index` into `out`.
    pub fn coords(&self, index: usize, out: &mut [u32]) {
        debug_assert_eq!(out.len(), self.lens.len());
        debug_assert!(index < self.size());
        let mut rest = index;
        for (slot, &len) in out.iter_mut().zip(&self.lens).rev() {
            *slot = (rest % len as usize) as u32;
            rest /= len as usize;
        }
    }

    pub fn axis_pos(&self, axis: &Axis) -> Option<usize> {
        self.axes.iter().position(|candidate| candidate == axis)
    }

    pub fn time_pos(&self) -> Option<usize> {
        self.axes
            .iter()
            .position(|axis| matches!(axis, Axis::Time { .. }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::TimeLevel;
    use crate::ids::{ListId, SubsetId, TimeRangeId};

    fn three_axis_shape() -> Shape {
        Shape::new(
            vec![
                Axis::List(ListId::new()),
                Axis::Subset(SubsetId::new()),
                Axis::Versions,
            ],
            vec![3, 4, 2],
        )
    }

    #[test]
    fn index_coords_roundtrip() {
        let shape = three_axis_shape();
        assert_eq!(shape.strides, vec![8, 2, 1]);
        assert_eq!(shape.size(), 24);
        assert_eq!(shape.index(&[2, 3, 1]), 23);
        let mut coords = [0; 3];
        shape.coords(23, &mut coords);
        assert_eq!(coords, [2, 3, 1]);
        for index in 0..shape.size() {
            shape.coords(index, &mut coords);
            assert_eq!(shape.index(&coords), index);
        }
    }

    #[test]
    fn scalar_shape_has_one_cell() {
        let shape = Shape::new(Vec::new(), Vec::new());
        assert_eq!(shape.size(), 1);
        assert_eq!(shape.index(&[]), 0);
        shape.coords(0, &mut []);
    }

    #[test]
    fn axis_and_time_positions() {
        let list = ListId::new();
        let range = TimeRangeId::new();
        let time = Axis::Time {
            level: TimeLevel::Quarter,
            range: Some(range),
        };
        let shape = Shape::new(
            vec![Axis::List(list), time.clone(), Axis::Versions],
            vec![5, 8, 3],
        );
        assert_eq!(shape.axis_pos(&Axis::List(list)), Some(0));
        assert_eq!(shape.axis_pos(&time), Some(1));
        assert_eq!(shape.axis_pos(&Axis::Versions), Some(2));
        assert_eq!(shape.axis_pos(&Axis::ListTop(list)), None);
        assert_eq!(shape.time_pos(), Some(1));
        assert_eq!(three_axis_shape().time_pos(), None);
    }

    #[test]
    #[should_panic(expected = "one length per axis")]
    fn mismatched_axes_and_lens_panic() {
        Shape::new(vec![Axis::Versions], vec![1, 2]);
    }
}
