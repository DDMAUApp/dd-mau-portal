export const T = {
  // Navigation
  home: { en: "Home", es: "Inicio" },
  training: { en: "Training", es: "Capacitación" },
  operations: { en: "Operations", es: "Operaciones" },
  menu: { en: "Menu", es: "Menú" },
  schedule: { en: "Schedule", es: "Horario" },

  // Home
  welcome: { en: "Welcome", es: "Bienvenido" },
  staffPortal: { en: "Staff Portal", es: "Portal del Personal" },
  logout: { en: "Logout", es: "Cerrar Sesión" },
  selectStaff: { en: "Select Your Name", es: "Selecciona Tu Nombre" },
  searchStaff: { en: "Search staff...", es: "Buscar personal..." },

  // Training
  trainingHub: { en: "Training Hub", es: "Centro de Capacitación" },
  progress: { en: "Progress", es: "Progreso" },
  complete: { en: "Complete", es: "Completar" },
  incomplete: { en: "Incomplete", es: "Incompleto" },
  lessons: { en: "Lessons", es: "Lecciones" },

  // Operations
  dailyOps: { en: "Daily Operations", es: "Operaciones Diarias" },
  passwordProtected: { en: "Password Protected", es: "Protegido por Contraseña" },
  enterPassword: { en: "Enter Password", es: "Ingresa Contraseña" },
  unlock: { en: "Unlock", es: "Desbloquear" },
  openingChecklist: { en: "Opening Checklist", es: "Lista de Verificación de Apertura" },
  closingChecklist: { en: "Closing Checklist", es: "Lista de Verificación de Cierre" },
  inventory: { en: "Inventory", es: "Inventario" },
  count: { en: "Count", es: "Cantidad" },
  supplier: { en: "Supplier", es: "Proveedor" },
  orderDay: { en: "Order Day", es: "Día de Pedido" },
  lastUpdated: { en: "Last Updated", es: "Última Actualización" },

  // Menu
  menuReference: { en: "Menu Reference", es: "Referencia del Menú" },
  price: { en: "Price", es: "Precio" },
  description: { en: "Description", es: "Descripción" },
  allergens: { en: "Allergens", es: "Alergenos" },
  spicy: { en: "Spicy", es: "Picante" },
  popular: { en: "Popular", es: "Popular" },

  // Schedule
  weeklySchedule: { en: "Weekly Schedule", es: "Horario Semanal" },
  shift: { en: "Shift", es: "Turno" },
  timeOff: { en: "Time Off Requests", es: "Solicitudes de Tiempo Libre" },
  reason: { en: "Reason", es: "Razón" },
  status: { en: "Status", es: "Estado" },
  approved: { en: "Approved", es: "Aprobado" },
  pending: { en: "Pending", es: "Pendiente" },
  noSchedule: { en: "Not scheduled this week", es: "No programado esta semana" },

  // Admin
  admin: { en: "Admin", es: "Admin" },
  adminPanel: { en: "Admin Panel", es: "Panel de Administración" },
  manageStaff: { en: "Manage Staff", es: "Administrar Personal" },
  changePIN: { en: "Change PIN", es: "Cambiar PIN" },
  addStaff: { en: "Add Staff Member", es: "Agregar Miembro del Personal" },
  removeStaff: { en: "Remove", es: "Eliminar" },
  newPIN: { en: "New PIN", es: "Nuevo PIN" },
  save: { en: "Save", es: "Guardar" },
  cancel: { en: "Cancel", es: "Cancelar" },
  staffName: { en: "Name", es: "Nombre" },
  staffRole: { en: "Role", es: "Rol" },
  staffPIN: { en: "PIN", es: "PIN" },
  saved: { en: "Saved!", es: "¡Guardado!" },
  confirmRemove: { en: "Remove this person?", es: "¿Eliminar a esta persona?" },

  // Recipes
  recipes: { en: "Recipes", es: "Recetas" },
  recipesTitle: { en: "Kitchen Recipes", es: "Recetas de Cocina" },
  prepTime: { en: "Prep Time", es: "Tiempo de Preparación" },
  cookTime: { en: "Cook Time", es: "Tiempo de Cocción" },
  ingredients: { en: "Ingredients", es: "Ingredientes" },
  instructions: { en: "Instructions", es: "Instrucciones" },
  yields: { en: "Yields", es: "Porciones" },

  // Catering
  cateringOrders: { en: "Catering Orders", es: "Pedidos de Catering" },
  newOrder: { en: "New Order", es: "Nuevo Pedido" },
  customerInfo: { en: "Customer Info", es: "Info del Cliente" },
  menuItems: { en: "Menu Items", es: "Artículos del Menú" },
  orderSummary: { en: "Order Summary", es: "Resumen del Pedido" },
  submitOrder: { en: "Submit Order", es: "Enviar Pedido" },
  pickupOrDelivery: { en: "Pickup or Delivery?", es: "¿Recoger o Entrega?" },
  pickup: { en: "Pickup", es: "Recoger" },
  delivery: { en: "Delivery", es: "Entrega" },
  specialNotes: { en: "Special Notes", es: "Notas Especiales" },

  // Labor
  laborPercent: { en: "Labor %", es: "% de Mano de Obra" },
  laborDashboard: { en: "Labor Dashboard", es: "Panel de Mano de Obra" },
  currentLabor: { en: "Current Labor", es: "Mano de Obra Actual" },
  target: { en: "Target", es: "Meta" },
  laborCost: { en: "Labor Cost", es: "Costo de Mano de Obra" },
  netSales: { en: "Net Sales", es: "Ventas Netas" },
  dataFromToast: { en: "Live from Toast POS", es: "En vivo desde Toast POS" },
  noLaborData: { en: "No labor data yet. Waiting for Toast sync...", es: "Sin datos de mano de obra. Esperando sincronización de Toast..." },
  overTarget: { en: "Over Target", es: "Sobre la Meta" },
  underTarget: { en: "Under Target", es: "Bajo la Meta" },
  onTarget: { en: "On Target", es: "En la Meta" },
  laborHistory: { en: "Today's Trend", es: "Tendencia de Hoy" }
};

export function t(key, lang) {
  return T[key]?.[lang === "es" ? "es" : "en"] || key;
}

export const KITCHEN_DICT_EN_ES = {
  "chicken": "pollo", "beef": "res", "pork": "puerco", "shrimp": "camarón", "fish": "pescado", "salmon": "salmón", "tofu": "tofu",
  "egg": "huevo", "eggs": "huevos", "rice": "arroz", "noodles": "fideos", "flour": "harina", "sugar": "azúcar", "salt": "sal",
  "pepper": "pimienta", "oil": "aceite", "vinegar": "vinagre", "sauce": "salsa", "butter": "mantequilla", "cream": "crema",
  "milk": "leche", "cheese": "queso", "onion": "cebolla", "garlic": "ajo", "ginger": "jengibre", "cilantro": "cilantro",
  "lime": "limón", "lemon": "limón amarillo", "tomato": "jitomate", "carrot": "zanahoria", "cabbage": "col", "lettuce": "lechuga",
  "mushroom": "hongo", "broccoli": "brócoli", "cucumber": "pepino", "jalapeño": "jalapeño", "avocado": "aguacate",
  "bean": "frijol", "beans": "frijoles", "corn": "maíz", "potato": "papa", "sweet potato": "camote",
  "frozen": "congelado", "fresh": "fresco", "chopped": "picado", "sliced": "rebanado", "diced": "en cubos", "whole": "entero",
  "bag": "bolsa", "box": "caja", "can": "lata", "bottle": "botella", "container": "envase", "cups": "vasos", "lids": "tapas",
  "gloves": "guantes", "towels": "toallas", "soap": "jabón", "bleach": "cloro", "napkins": "servilletas",
  "spoon": "cuchara", "fork": "tenedor", "knife": "cuchillo", "plate": "plato", "bowl": "tazón",
  "large": "grande", "small": "chico", "medium": "mediano",
  "white": "blanco", "black": "negro", "red": "rojo", "green": "verde", "brown": "café",
  "hot": "caliente", "cold": "frío", "dry": "seco", "wet": "mojado",
  "straw": "popote", "straws": "popotes", "lid": "tapa", "cup": "vaso", "tray": "charola"
};

export const KITCHEN_DICT_ES_EN = {};
Object.entries(KITCHEN_DICT_EN_ES).forEach(([en, es]) => { KITCHEN_DICT_ES_EN[es] = en; });

export function autoTranslateItem(name) {
  const lower = name.toLowerCase().trim();
  const spanishMarkers = ["de", "del", "para", "con", "sin", "en", "la", "el", "los", "las", "y", "o"];
  const words = lower.split(/\s+/);
  const hasSpanish = words.some(w => spanishMarkers.includes(w)) || words.some(w => KITCHEN_DICT_ES_EN[w]);
  const hasEnglish = words.some(w => KITCHEN_DICT_EN_ES[w]);

  if (hasSpanish && !hasEnglish) {
    const translated = words.map(w => KITCHEN_DICT_ES_EN[w] || w).join(" ");
    const cap = translated.charAt(0).toUpperCase() + translated.slice(1);
    return { name: cap, nameEs: name.trim() };
  } else {
    const translated = words.map(w => KITCHEN_DICT_EN_ES[w] || w).join(" ");
    const cap = translated.charAt(0).toUpperCase() + translated.slice(1);
    return { name: name.trim(), nameEs: cap };
  }
}
