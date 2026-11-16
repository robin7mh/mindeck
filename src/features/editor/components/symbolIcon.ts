import { Box, Braces, Brackets, Hash, Key, Puzzle, Quote, SquareFunction, ToggleLeft, Type, Variable, Wrench, Zap, type LucideIcon } from 'lucide-react'

/** Icon and tint of a symbol kind (Monaco's, 0-based) — in the outline and the breadcrumbs. */
export function symbolIcon(kind: number): { Icon: LucideIcon; tint: string } {
  switch (kind) {
    case 4: // class
    case 22: // struct
      return { Icon: Box, tint: 'text-amber/90' }
    case 10: // interface
    case 25: // type parameter
      return { Icon: Puzzle, tint: 'text-blue/90' }
    case 9: // enum
    case 21: // enum member
      return { Icon: Type, tint: 'text-amber/80' }
    case 5: // method
    case 11: // function
      return { Icon: SquareFunction, tint: 'text-purple/90' }
    case 8: // constructor
      return { Icon: Wrench, tint: 'text-purple/90' }
    case 6: // property
    case 7: // field
    case 19: // key
      return { Icon: Key, tint: 'text-blue/80' }
    case 12: // variable
    case 13: // constant
      return { Icon: Variable, tint: 'text-cyan/90' }
    case 14: // string
      return { Icon: Quote, tint: 'text-green/80' }
    case 15: // number
      return { Icon: Hash, tint: 'text-green/80' }
    case 16: // boolean
      return { Icon: ToggleLeft, tint: 'text-green/80' }
    case 17: // array
      return { Icon: Brackets, tint: 'text-text-secondary' }
    case 23: // event
      return { Icon: Zap, tint: 'text-amber/80' }
    default: // file, module, namespace, package, object, null, operator
      return { Icon: Braces, tint: 'text-text-secondary' }
  }
}
