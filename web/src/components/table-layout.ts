/**
 * The layout shared by the members and users tables. Below `lg` the wide columns make way for the
 * same facts under the name, which keeps the table within the screen: the name cell then takes the
 * whole width and cuts long names short. A placeholder table has to follow the same layout.
 */
export const NAME_CELL = "w-full max-w-0 pl-4 lg:w-auto lg:max-w-64"
export const WIDE_CELL = "hidden lg:table-cell"
