import { useState, useEffect } from "react";
import { db } from "../firebase";
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  addDoc,
  collection,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { t } from "../data/translations";

/* ─── BOH TRAINING LESSONS ─── */
const BOH_LESSONS = [
  {
    id: "sink-cleaning",
    icon: "\u{1F6BF}",
    title: "Cleaning Sinks After Raw Chicken",
    titleEs: "Limpieza de Fregaderos Después de Pollo Crudo",
    content: [
      "After handling raw chicken in a sink, you MUST fully clean and sanitize it before any other use.",
      "1. Remove all visible food debris and scraps from the sink.",
      "2. Rinse the entire sink with hot water (at least 110°F / 43°C).",
      "3. Scrub all surfaces — basin, faucet handles, and surrounding counters — with soap and a clean brush or sponge.",
      "4. Rinse thoroughly with clean hot water.",
      "5. Apply sanitizer solution (1 tablespoon bleach per 1 gallon of water, or use approved quaternary sanitizer). Let it sit for at least 30 seconds.",
      "6. Air dry — do NOT wipe with a towel.",
      "7. Wash your hands thoroughly after finishing.",
    ],
    contentEs: [
      "Después de manejar pollo crudo en un fregadero, DEBES limpiarlo y desinfectarlo completamente antes de cualquier otro uso.",
      "1. Retira todos los restos de comida visibles del fregadero.",
      "2. Enjuaga todo el fregadero con agua caliente (al menos 110°F / 43°C).",
      "3. Friega todas las superficies — la pileta, las llaves y las superficies alrededor — con jabón y un cepillo o esponja limpia.",
      "4. Enjuaga bien con agua caliente limpia.",
      "5. Aplica solución desinfectante (1 cucharada de cloro por 1 galón de agua, o usa un desinfectante cuaternario aprobado). Déjalo actuar al menos 30 segundos.",
      "6. Deja secar al aire — NO seques con un trapo.",
      "7. Lávate las manos bien después de terminar.",
    ],
    keyPoint: "Raw chicken carries Salmonella and Campylobacter. A quick rinse is NOT enough.",
    keyPointEs: "El pollo crudo contiene Salmonella y Campylobacter. Un enjuague rápido NO es suficiente.",
  },
  {
    id: "fridge-storage",
    icon: "\u{1F9CA}",
    title: "Proper Meat Storage Order in the Fridge",
    titleEs: "Orden Correcto de Almacenamiento de Carnes en el Refrigerador",
    content: [
      "Store items in the fridge from TOP to BOTTOM in this order based on cooking temperature — lowest cooking temp on top, highest on bottom:",
      "",
      "\u{1F53D} TOP SHELF: Ready-to-eat foods (prepared items, fruits, vegetables, drinks)",
      "\u{1F53D} 2ND SHELF: Whole seafood / fish (cooking temp: 145°F)",
      "\u{1F53D} 3RD SHELF: Whole cuts of beef, pork, lamb (cooking temp: 145°F)",
      "\u{1F53D} 4TH SHELF: Ground meats and ground fish (cooking temp: 155°F)",
      "\u{1F53D} BOTTOM SHELF: Poultry — chicken, turkey, duck (cooking temp: 165°F)",
      "",
      "WHY THIS ORDER? If juices drip down, the item below requires a higher cooking temperature — which will kill any bacteria from the item above.",
      "",
      "Additional rules:",
      "• All raw meats must be covered or wrapped.",
      "• Label everything with name and date.",
      "• Use within 7 days of prep date (or by use-by date).",
      "• Keep fridge at 41°F (5°C) or below.",
    ],
    contentEs: [
      "Almacena los artículos en el refrigerador de ARRIBA a ABAJO en este orden según la temperatura de cocción — la temperatura más baja arriba, la más alta abajo:",
      "",
      "\u{1F53D} ESTANTE SUPERIOR: Alimentos listos para comer (preparados, frutas, verduras, bebidas)",
      "\u{1F53D} 2DO ESTANTE: Mariscos / pescado entero (temp de cocción: 145°F)",
      "\u{1F53D} 3ER ESTANTE: Cortes enteros de res, cerdo, cordero (temp de cocción: 145°F)",
      "\u{1F53D} 4TO ESTANTE: Carnes molidas y pescado molido (temp de cocción: 155°F)",
      "\u{1F53D} ESTANTE INFERIOR: Aves — pollo, pavo, pato (temp de cocción: 165°F)",
      "",
      "¿POR QUÉ ESTE ORDEN? Si los jugos gotean hacia abajo, el artículo de abajo requiere una temperatura de cocción más alta — lo que matará cualquier bacteria del artículo de arriba.",
      "",
      "Reglas adicionales:",
      "• Todas las carnes crudas deben estar cubiertas o envueltas.",
      "• Etiqueta todo con nombre y fecha.",
      "• Usa dentro de 7 días de la fecha de preparación (o antes de la fecha de vencimiento).",
      "• Mantén el refrigerador a 41°F (5°C) o menos.",
    ],
    keyPoint: "Remember: Ready-to-eat on TOP, Poultry on BOTTOM. Always.",
    keyPointEs: "Recuerda: Listos para comer ARRIBA, Aves ABAJO. Siempre.",
  },
  {
    id: "raw-meat-hands",
    icon: "\u{1F9FC}",
    title: "After Touching Raw Meat — Wash Your Hands!",
    titleEs: "Después de Tocar Carne Cruda — ¡Lávate las Manos!",
    content: [
      "Every time you handle raw meat, you MUST wash your hands before touching ANYTHING else. No exceptions.",
      "",
      "Proper handwashing steps:",
      "1. Wet hands with warm running water (at least 100°F).",
      "2. Apply soap and lather for at least 20 seconds.",
      "3. Scrub all surfaces — between fingers, under nails, back of hands, and wrists.",
      "4. Rinse under clean running water.",
      "5. Dry with a single-use paper towel or air dryer.",
      "6. Use the paper towel to turn off the faucet.",
      "",
      "You must also wash hands:",
      "• After using the restroom",
      "• After sneezing, coughing, or touching your face",
      "• After taking out trash",
      "• After handling chemicals / cleaning products",
      "• Before putting on gloves",
      "• When switching between raw and cooked foods",
    ],
    contentEs: [
      "Cada vez que manejes carne cruda, DEBES lavarte las manos antes de tocar CUALQUIER otra cosa. Sin excepciones.",
      "",
      "Pasos correctos para lavarse las manos:",
      "1. Moja las manos con agua tibia corriente (al menos 100°F).",
      "2. Aplica jabón y frota durante al menos 20 segundos.",
      "3. Friega todas las superficies — entre los dedos, debajo de las uñas, dorso de las manos y muñecas.",
      "4. Enjuaga con agua corriente limpia.",
      "5. Seca con una toalla de papel desechable o secador de aire.",
      "6. Usa la toalla de papel para cerrar la llave.",
      "",
      "También debes lavarte las manos:",
      "• Después de usar el baño",
      "• Después de estornudar, toser o tocarte la cara",
      "• Después de sacar la basura",
      "• Después de manejar químicos / productos de limpieza",
      "• Antes de ponerte guantes",
      "• Al cambiar entre alimentos crudos y cocidos",
    ],
    keyPoint: "20 seconds of scrubbing with soap. Every single time.",
    keyPointEs: "20 segundos frotando con jabón. Cada vez.",
  },
  {
    id: "sanitize-prep",
    icon: "\u{2728}",
    title: "How to Properly Wash & Sanitize a Prep Area",
    titleEs: "Cómo Lavar y Desinfectar Correctamente un Área de Preparación",
    content: [
      "Every prep surface must be cleaned AND sanitized. Cleaning removes dirt — sanitizing kills bacteria. You need BOTH.",
      "",
      "The 5-step process:",
      "1. SCRAPE: Remove all food scraps, debris, and trash from the surface.",
      "2. WASH: Use warm soapy water and a clean cloth or sponge. Scrub the entire surface.",
      "3. RINSE: Wipe down with clean water to remove all soap residue.",
      "4. SANITIZE: Apply approved sanitizer solution. Spray or wipe evenly across the whole surface. Let it sit for the required contact time (usually 30 seconds to 1 minute).",
      "5. AIR DRY: Let the surface air dry completely. Do NOT use a towel to dry it — this can re-contaminate the surface.",
      "",
      "When to sanitize your prep area:",
      "• Before starting any food prep",
      "• After finishing food prep",
      "• When switching between different food types (raw to cooked, meat to vegetables)",
      "• Every 4 hours during continuous use",
      "• After any spill or contamination",
    ],
    contentEs: [
      "Cada superficie de preparación debe ser limpiada Y desinfectada. Limpiar remueve la suciedad — desinfectar mata las bacterias. Necesitas AMBOS.",
      "",
      "El proceso de 5 pasos:",
      "1. RASPAR: Retira todos los restos de comida, residuos y basura de la superficie.",
      "2. LAVAR: Usa agua tibia con jabón y un trapo o esponja limpia. Friega toda la superficie.",
      "3. ENJUAGAR: Limpia con agua limpia para remover todo el residuo de jabón.",
      "4. DESINFECTAR: Aplica solución desinfectante aprobada. Rocía o limpia uniformemente toda la superficie. Déjala actuar el tiempo requerido (usualmente 30 segundos a 1 minuto).",
      "5. SECAR AL AIRE: Deja que la superficie se seque completamente al aire. NO uses un trapo para secarla — esto puede re-contaminar la superficie.",
      "",
      "Cuándo desinfectar tu área de preparación:",
      "• Antes de comenzar cualquier preparación de alimentos",
      "• Después de terminar la preparación",
      "• Al cambiar entre diferentes tipos de alimentos (crudo a cocido, carne a verduras)",
      "• Cada 4 horas durante uso continuo",
      "• Después de cualquier derrame o contaminación",
    ],
    keyPoint: "Clean ≠ Sanitized. You must do both, every time.",
    keyPointEs: "Limpio ≠ Desinfectado. Debes hacer ambos, cada vez.",
  },
  {
    id: "clean-as-you-go",
    icon: "\u{1F9F9}",
    title: "Clean As You Go & Station Cleanup Before Breaks",
    titleEs: "Limpia Mientras Trabajas y Limpieza de Estación Antes de Descansos",
    content: [
      "CLEAN AS YOU GO means cleaning up messes, spills, and dirty tools immediately — not waiting until the end of your shift.",
      "",
      "Why it matters:",
      "• Prevents cross-contamination between foods",
      "• Reduces pest attraction (flies, roaches)",
      "• Keeps your workspace safe (no slipping on spills)",
      "• Makes end-of-day cleanup faster",
      "• Shows professionalism and respect for your team",
      "",
      "Clean-as-you-go habits:",
      "• Wipe down your cutting board between tasks",
      "• Put tools back in their place after using them",
      "• Throw away scraps and packaging immediately",
      "• Wipe up any spills on floors or counters right away",
      "• Keep a sanitizer bucket and clean towels at your station",
      "",
      "BEFORE TAKING A BREAK you must:",
      "1. Put away all perishable items (return to fridge/cooler)",
      "2. Cover any items that must stay out",
      "3. Clean and sanitize your cutting board and work surface",
      "4. Put dirty dishes in the dish area",
      "5. Wipe down your station",
      "6. Wash your hands before and after your break",
      "",
      "Your station should look clean enough that someone else could step in and start working.",
    ],
    contentEs: [
      "LIMPIA MIENTRAS TRABAJAS significa limpiar desorden, derrames y utensilios sucios inmediatamente — no esperar hasta el final de tu turno.",
      "",
      "Por qué es importante:",
      "• Previene la contaminación cruzada entre alimentos",
      "• Reduce la atracción de plagas (moscas, cucarachas)",
      "• Mantiene tu espacio de trabajo seguro (no resbalones por derrames)",
      "• Hace la limpieza de fin de día más rápida",
      "• Muestra profesionalismo y respeto por tu equipo",
      "",
      "Hábitos de limpieza continua:",
      "• Limpia tu tabla de cortar entre tareas",
      "• Regresa las herramientas a su lugar después de usarlas",
      "• Tira los restos y empaques inmediatamente",
      "• Limpia cualquier derrame en pisos o mostradores de inmediato",
      "• Mantén un balde de desinfectante y trapos limpios en tu estación",
      "",
      "ANTES DE TOMAR UN DESCANSO debes:",
      "1. Guardar todos los artículos perecederos (regresar al refrigerador/enfriador)",
      "2. Cubrir cualquier artículo que deba quedarse afuera",
      "3. Limpiar y desinfectar tu tabla de cortar y superficie de trabajo",
      "4. Poner los platos sucios en el área de lavado",
      "5. Limpiar tu estación",
      "6. Lavarte las manos antes y después de tu descanso",
      "",
      "Tu estación debe verse lo suficientemente limpia para que otra persona pueda comenzar a trabajar.",
    ],
    keyPoint: "Leave your station ready for someone else to use. Every break. Every time.",
    keyPointEs: "Deja tu estación lista para que otra persona la use. Cada descanso. Cada vez.",
  },
  {
    id: "food-safety-hygiene",
    icon: "\u{1F9AB}",
    title: "Food Safety & Personal Hygiene",
    titleEs: "Seguridad Alimentaria e Higiene Personal",
    content: [
      "Food safety starts with YOU. Your personal hygiene directly affects every dish that leaves this kitchen.",
      "",
      "Personal hygiene rules:",
      "• Shower before every shift — come to work clean.",
      "• Wear a clean uniform/apron every shift.",
      "• Keep fingernails short and clean — no nail polish or artificial nails.",
      "• No jewelry on hands or wrists (rings, watches, bracelets) while handling food.",
      "• Hair must be restrained — wear a hat, hairnet, or head covering at all times.",
      "• Do NOT come to work if you are sick — especially vomiting, diarrhea, fever, or jaundice.",
      "• Cover any cuts or wounds with a bandage AND a glove.",
      "",
      "Key food safety temperatures:",
      "• Cold foods: keep at 41°F (5°C) or below",
      "• Hot foods: keep at 135°F (57°C) or above",
      "• DANGER ZONE: 41°F – 135°F — bacteria grow rapidly in this range",
      "• Never leave food in the danger zone for more than 2 hours (1 hour if above 90°F outside)",
      "",
      "Cross-contamination prevention:",
      "• Use separate cutting boards for raw meat vs. vegetables vs. cooked food.",
      "• Never use the same knife for raw and cooked food without washing it first.",
      "• Store raw meats below ready-to-eat foods (never above).",
      "• Change gloves between tasks — especially between raw and cooked foods.",
      "• Use color-coded towels: one for sanitizing surfaces, one for drying hands.",
    ],
    contentEs: [
      "La seguridad alimentaria comienza CONTIGO. Tu higiene personal afecta directamente cada plato que sale de esta cocina.",
      "",
      "Reglas de higiene personal:",
      "• Báñate antes de cada turno — llega al trabajo limpio.",
      "• Usa un uniforme/delantal limpio cada turno.",
      "• Mantén las uñas cortas y limpias — no esmalte de uñas ni uñas artificiales.",
      "• No uses joyería en manos o muñecas (anillos, relojes, pulseras) al manejar alimentos.",
      "• El cabello debe estar recogido — usa gorra, red para el cabello o cubierta en todo momento.",
      "• NO vengas a trabajar si estás enfermo — especialmente con vómito, diarrea, fiebre o ictericia.",
      "• Cubre cualquier cortada o herida con un vendaje Y un guante.",
      "",
      "Temperaturas clave de seguridad alimentaria:",
      "• Alimentos fríos: mantener a 41°F (5°C) o menos",
      "• Alimentos calientes: mantener a 135°F (57°C) o más",
      "• ZONA DE PELIGRO: 41°F – 135°F — las bacterias crecen rápidamente en este rango",
      "• Nunca dejes alimentos en la zona de peligro por más de 2 horas (1 hora si la temperatura exterior supera los 90°F)",
      "",
      "Prevención de contaminación cruzada:",
      "• Usa tablas de cortar separadas para carne cruda vs. verduras vs. alimentos cocidos.",
      "• Nunca uses el mismo cuchillo para alimentos crudos y cocidos sin lavarlo primero.",
      "• Almacena carnes crudas debajo de alimentos listos para comer (nunca encima).",
      "• Cambia los guantes entre tareas — especialmente entre alimentos crudos y cocidos.",
      "• Usa trapos de colores diferentes: uno para desinfectar superficies, otro para secar manos.",
    ],
    keyPoint: "The Danger Zone is 41°F – 135°F. Keep cold food cold, hot food hot. No exceptions.",
    keyPointEs: "La Zona de Peligro es 41°F – 135°F. Mantén los alimentos fríos fríos y los calientes calientes. Sin excepciones.",
  },
  {
    id: "knife-safety",
    icon: "\u{1F52A}",
    title: "Knife Safety",
    titleEs: "Seguridad con Cuchillos",
    content: [
      "Knives are the most important tool in the kitchen — and the most dangerous if misused. Respect the blade.",
      "",
      "Basic knife safety rules:",
      "1. Always use a sharp knife. A dull knife requires more force and is more likely to slip.",
      "2. Cut AWAY from your body, never toward yourself.",
      "3. Use the right knife for the job — don't use a chef's knife to open boxes or a paring knife to cut a watermelon.",
      "4. Keep your eyes on the blade while cutting. No looking away, no talking to someone while chopping.",
      "5. Use the \"claw grip\" on the food you're cutting — curl your fingertips under and use your knuckles as a guide.",
      "6. Never try to catch a falling knife. Step back and let it fall.",
      "7. When walking with a knife, hold it at your side with the blade pointing down and say \"behind\" or \"knife behind\" when passing others.",
      "",
      "Cutting board safety:",
      "• Place a damp towel under your cutting board to prevent it from sliding.",
      "• Never cut on a wet, slippery surface.",
      "• Use separate boards for raw meats vs. produce.",
      "",
      "Storage and washing:",
      "• Never leave knives in a sink full of water — someone could reach in and get cut.",
      "• Wash knives by hand, not in a dishwasher.",
      "• Store knives in a knife rack, magnetic strip, or blade guard — never loose in a drawer.",
      "• After washing, dry the blade carefully by wiping away from the edge.",
    ],
    contentEs: [
      "Los cuchillos son la herramienta más importante en la cocina — y la más peligrosa si se usan mal. Respeta la hoja.",
      "",
      "Reglas básicas de seguridad con cuchillos:",
      "1. Siempre usa un cuchillo afilado. Un cuchillo sin filo requiere más fuerza y es más probable que resbale.",
      "2. Corta LEJOS de tu cuerpo, nunca hacia ti.",
      "3. Usa el cuchillo correcto para el trabajo — no uses un cuchillo de chef para abrir cajas ni un cuchillo pelador para cortar una sandía.",
      "4. Mantén tus ojos en la hoja mientras cortas. No mires a otro lado, no hables con alguien mientras picas.",
      "5. Usa el \"agarre de garra\" en el alimento que estás cortando — curva las puntas de tus dedos hacia abajo y usa tus nudillos como guía.",
      "6. Nunca intentes atrapar un cuchillo que se cae. Retrocede y déjalo caer.",
      "7. Al caminar con un cuchillo, sostenlo a tu lado con la hoja apuntando hacia abajo y di \"atrás\" o \"cuchillo atrás\" al pasar junto a otros.",
      "",
      "Seguridad con tabla de cortar:",
      "• Coloca un trapo húmedo debajo de tu tabla de cortar para evitar que se deslice.",
      "• Nunca cortes sobre una superficie mojada y resbaladiza.",
      "• Usa tablas separadas para carnes crudas vs. productos frescos.",
      "",
      "Almacenamiento y lavado:",
      "• Nunca dejes cuchillos en un fregadero lleno de agua — alguien podría meter la mano y cortarse.",
      "• Lava los cuchillos a mano, no en el lavavajillas.",
      "• Guarda los cuchillos en un soporte, tira magnética o funda — nunca sueltos en un cajón.",
      "• Después de lavar, seca la hoja cuidadosamente limpiando lejos del filo.",
    ],
    keyPoint: "Never catch a falling knife. Never leave a knife in a sink. Always say \"knife behind\" when walking.",
    keyPointEs: "Nunca atrapes un cuchillo que se cae. Nunca dejes un cuchillo en un fregadero. Siempre di \"cuchillo atrás\" al caminar.",
  },
  {
    id: "fifo",
    icon: "\u{1F4E6}",
    title: "FIFO — First In, First Out",
    titleEs: "FIFO — Primero en Entrar, Primero en Salir",
    content: [
      "FIFO stands for First In, First Out. It means you always USE the oldest product first and place newer product BEHIND it.",
      "",
      "Why FIFO matters:",
      "• Prevents food waste — older items get used before they expire.",
      "• Reduces spoilage and the risk of serving expired food.",
      "• Keeps inventory organized and easy to manage.",
      "• It's required by health code — inspectors check for this.",
      "",
      "How to practice FIFO:",
      "1. LABEL everything — write the item name and the date it was prepped or opened.",
      "2. When stocking shelves or the walk-in, pull OLDER items to the FRONT.",
      "3. Place NEWER items in the BACK, behind the older ones.",
      "4. Always check dates BEFORE using an item. If it's expired, throw it away.",
      "5. During deliveries, never place new cases on top of old ones. Rotate the stock.",
      "",
      "Date labeling rules:",
      "• Every prep container must have: item name + prep date.",
      "• Opened items (sauces, cans, bags): write the date opened.",
      "• Use-by rule: Most prepped items must be used within 7 days of preparation.",
      "• If an item has no label, do NOT use it — ask a manager or throw it away.",
      "",
      "Common FIFO mistakes:",
      "• Stacking new deliveries on top of old ones without rotating.",
      "• Not labeling prepped items ('I'll remember when I made it' — no you won't).",
      "• Ignoring expiration dates because 'it still looks fine.'",
      "• Pushing old product to the back to make room for new product.",
    ],
    contentEs: [
      "FIFO significa Primero en Entrar, Primero en Salir. Significa que siempre USAS el producto más antiguo primero y colocas el producto más nuevo DETRÁS.",
      "",
      "Por qué es importante el FIFO:",
      "• Previene el desperdicio de alimentos — los artículos más antiguos se usan antes de que expiren.",
      "• Reduce el deterioro y el riesgo de servir comida vencida.",
      "• Mantiene el inventario organizado y fácil de manejar.",
      "• Es requerido por el código de salud — los inspectores lo verifican.",
      "",
      "Cómo practicar FIFO:",
      "1. ETIQUETA todo — escribe el nombre del artículo y la fecha en que se preparó o abrió.",
      "2. Al surtir estantes o el refrigerador, jala los artículos MÁS ANTIGUOS al FRENTE.",
      "3. Coloca los artículos MÁS NUEVOS en la PARTE DE ATRÁS, detrás de los más antiguos.",
      "4. Siempre verifica las fechas ANTES de usar un artículo. Si está vencido, tíralo.",
      "5. Durante las entregas, nunca coloques cajas nuevas encima de las viejas. Rota el inventario.",
      "",
      "Reglas de etiquetado de fechas:",
      "• Cada contenedor de preparación debe tener: nombre del artículo + fecha de preparación.",
      "• Artículos abiertos (salsas, latas, bolsas): escribe la fecha en que se abrió.",
      "• Regla de uso: La mayoría de artículos preparados deben usarse dentro de 7 días de preparación.",
      "• Si un artículo no tiene etiqueta, NO lo uses — pregunta a un gerente o tíralo.",
      "",
      "Errores comunes de FIFO:",
      "• Apilar entregas nuevas encima de las viejas sin rotar.",
      "• No etiquetar artículos preparados ('me voy a acordar cuándo lo hice' — no, no te vas a acordar).",
      "• Ignorar fechas de vencimiento porque 'todavía se ve bien.'",
      "• Empujar el producto viejo hacia atrás para hacer espacio para el nuevo.",
    ],
    keyPoint: "Label everything. Oldest in front, newest in back. No label = don't use it.",
    keyPointEs: "Etiqueta todo. Lo más antiguo al frente, lo más nuevo atrás. Sin etiqueta = no lo uses.",
  },
];

/* ─── 15-QUESTION BOH TEST ─── */
const BOH_TEST = [
  {
    id: 1,
    type: "mc",
    q: "After handling raw chicken in a sink, what is the correct next step?",
    qEs: "Después de manejar pollo crudo en un fregadero, ¿cuál es el siguiente paso correcto?",
    options: [
      "Rinse with cold water and use immediately",
      "Remove debris, wash with soap, rinse, and sanitize",
      "Wipe with a dry towel",
      "Spray with water and let air dry",
    ],
    optionsEs: [
      "Enjuagar con agua fría y usar inmediatamente",
      "Retirar residuos, lavar con jabón, enjuagar y desinfectar",
      "Limpiar con un trapo seco",
      "Rociar con agua y dejar secar al aire",
    ],
    answer: 1,
  },
  {
    id: 2,
    type: "tf",
    q: "It is okay to dry a sanitized sink with a towel instead of letting it air dry.",
    qEs: "Está bien secar un fregadero desinfectado con un trapo en vez de dejarlo secar al aire.",
    answer: false,
  },
  {
    id: 3,
    type: "mc",
    q: "What should be stored on the BOTTOM shelf of the fridge?",
    qEs: "¿Qué debe almacenarse en el estante INFERIOR del refrigerador?",
    options: [
      "Ready-to-eat foods",
      "Whole fish and seafood",
      "Ground meats",
      "Poultry (chicken, turkey, duck)",
    ],
    optionsEs: [
      "Alimentos listos para comer",
      "Pescado y mariscos enteros",
      "Carnes molidas",
      "Aves (pollo, pavo, pato)",
    ],
    answer: 3,
  },
  {
    id: 4,
    type: "mc",
    q: "Why is poultry stored on the bottom shelf?",
    qEs: "¿Por qué se almacenan las aves en el estante inferior?",
    options: [
      "Because it is the heaviest",
      "Because poultry requires the highest cooking temperature (165°F), which kills any bacteria that drips down",
      "Because it smells the most",
      "Because it is used the least",
    ],
    optionsEs: [
      "Porque es lo más pesado",
      "Porque las aves requieren la temperatura de cocción más alta (165°F), lo que mata cualquier bacteria que gotee",
      "Porque huele más",
      "Porque se usa menos",
    ],
    answer: 1,
  },
  {
    id: 5,
    type: "tf",
    q: "Ground meats should be stored above whole cuts of beef in the fridge.",
    qEs: "Las carnes molidas deben almacenarse encima de los cortes enteros de res en el refrigerador.",
    answer: false,
  },
  {
    id: 6,
    type: "mc",
    q: "How long should you scrub your hands with soap when washing?",
    qEs: "¿Cuánto tiempo debes frotar tus manos con jabón al lavártelas?",
    options: [
      "5 seconds",
      "10 seconds",
      "20 seconds",
      "60 seconds",
    ],
    optionsEs: [
      "5 segundos",
      "10 segundos",
      "20 segundos",
      "60 segundos",
    ],
    answer: 2,
  },
  {
    id: 7,
    type: "tf",
    q: "You should wash your hands before putting on gloves.",
    qEs: "Debes lavarte las manos antes de ponerte guantes.",
    answer: true,
  },
  {
    id: 8,
    type: "mc",
    q: "After washing your hands, how should you turn off the faucet?",
    qEs: "Después de lavarte las manos, ¿cómo debes cerrar la llave?",
    options: [
      "With your clean bare hands",
      "With a paper towel",
      "With your elbow",
      "Leave it running for the next person",
    ],
    optionsEs: [
      "Con tus manos limpias",
      "Con una toalla de papel",
      "Con tu codo",
      "Déjala abierta para la siguiente persona",
    ],
    answer: 1,
  },
  {
    id: 9,
    type: "mc",
    q: "What are the 5 steps to properly clean and sanitize a prep area?",
    qEs: "¿Cuáles son los 5 pasos para limpiar y desinfectar correctamente un área de preparación?",
    options: [
      "Sweep, mop, spray, wipe, repeat",
      "Scrape, wash, rinse, sanitize, air dry",
      "Rinse, dry, spray, wipe, rinse",
      "Spray, scrub, rinse, towel dry, spray again",
    ],
    optionsEs: [
      "Barrer, trapear, rociar, limpiar, repetir",
      "Raspar, lavar, enjuagar, desinfectar, secar al aire",
      "Enjuagar, secar, rociar, limpiar, enjuagar",
      "Rociar, fregar, enjuagar, secar con trapo, rociar de nuevo",
    ],
    answer: 1,
  },
  {
    id: 10,
    type: "tf",
    q: "Cleaning a surface is the same thing as sanitizing it.",
    qEs: "Limpiar una superficie es lo mismo que desinfectarla.",
    answer: false,
  },
  {
    id: 11,
    type: "mc",
    q: "How often should you sanitize your prep area during continuous use?",
    qEs: "¿Con qué frecuencia debes desinfectar tu área de preparación durante uso continuo?",
    options: [
      "Once at the start of the day",
      "Every 4 hours",
      "Only when it looks dirty",
      "Once at the end of the day",
    ],
    optionsEs: [
      "Una vez al inicio del día",
      "Cada 4 horas",
      "Solo cuando se ve sucia",
      "Una vez al final del día",
    ],
    answer: 1,
  },
  {
    id: 12,
    type: "tf",
    q: "It is okay to leave perishable items on your station while you take a break.",
    qEs: "Está bien dejar artículos perecederos en tu estación mientras tomas un descanso.",
    answer: false,
  },
  {
    id: 13,
    type: "mc",
    q: "Before taking a break, what should your station look like?",
    qEs: "Antes de tomar un descanso, ¿cómo debe verse tu estación?",
    options: [
      "Messy is fine, you'll clean it after break",
      "Clean enough for someone else to step in and start working",
      "Just push everything to the side",
      "Cover everything with towels",
    ],
    optionsEs: [
      "Desordenada está bien, la limpiarás después del descanso",
      "Lo suficientemente limpia para que otra persona pueda comenzar a trabajar",
      "Solo empuja todo a un lado",
      "Cubre todo con trapos",
    ],
    answer: 1,
  },
  {
    id: 14,
    type: "tf",
    q: "The fridge should be kept at 41°F (5°C) or below.",
    qEs: "El refrigerador debe mantenerse a 41°F (5°C) o menos.",
    answer: true,
  },
  {
    id: 15,
    type: "mc",
    q: "What is the minimum sanitizer contact time for a prep surface?",
    qEs: "¿Cuál es el tiempo mínimo de contacto del desinfectante en una superficie de preparación?",
    options: [
      "5 seconds",
      "10 seconds",
      "30 seconds",
      "5 minutes",
    ],
    optionsEs: [
      "5 segundos",
      "10 segundos",
      "30 segundos",
      "5 minutos",
    ],
    answer: 2,
  },
  {
    id: 16,
    type: "mc",
    q: "What is the temperature range of the Danger Zone?",
    qEs: "\u00BFCuál es el rango de temperatura de la Zona de Peligro?",
    options: [
      "32°F – 100°F",
      "41°F – 135°F",
      "50°F – 150°F",
      "0°F – 41°F",
    ],
    optionsEs: [
      "32°F – 100°F",
      "41°F – 135°F",
      "50°F – 150°F",
      "0°F – 41°F",
    ],
    answer: 1,
  },
  {
    id: 17,
    type: "tf",
    q: "You should try to catch a falling knife to prevent it from hitting the floor.",
    qEs: "Debes intentar atrapar un cuchillo que se cae para evitar que golpee el piso.",
    answer: false,
  },
  {
    id: 18,
    type: "mc",
    q: "When walking with a knife, what should you do?",
    qEs: "Al caminar con un cuchillo, \u00BFqué debes hacer?",
    options: [
      "Hold it in front of you with the blade up",
      "Hold it at your side with the blade down and say \"knife behind\"",
      "Carry it behind your back",
      "Wave it so people can see it",
    ],
    optionsEs: [
      "Sostenerlo frente a ti con la hoja hacia arriba",
      "Sostenerlo a tu lado con la hoja hacia abajo y decir \"cuchillo atrás\"",
      "Cargarlo detrás de tu espalda",
      "Moverlo para que la gente lo vea",
    ],
    answer: 1,
  },
  {
    id: 19,
    type: "mc",
    q: "What does FIFO stand for?",
    qEs: "\u00BFQué significa FIFO?",
    options: [
      "Fill In, Fill Out",
      "First In, First Out",
      "Food Inventory for Orders",
      "Freeze It, Fridge Only",
    ],
    optionsEs: [
      "Llenar, Vaciar",
      "Primero en Entrar, Primero en Salir",
      "Inventario de Alimentos para Pedidos",
      "Congelar, Solo Refrigerador",
    ],
    answer: 1,
  },
  {
    id: 20,
    type: "tf",
    q: "When stocking shelves, newer items should go in the front and older items in the back.",
    qEs: "Al surtir estantes, los artículos más nuevos deben ir al frente y los más antiguos atrás.",
    answer: false,
  },
];


const PASS_THRESHOLD = 0.8; // 16 out of 20

/* ─── MAIN COMPONENT ─── */
export default function TrainingHub({ staffName, language, staffList }) {
  const [mainTab, setMainTab] = useState("boh"); // "foh" | "boh"
  const [bohView, setBohView] = useState("lessons"); // "lessons" | "test" | "results" | "tracker"
  const [expandedLesson, setExpandedLesson] = useState(null);
  const [testAnswers, setTestAnswers] = useState({});
  const [testResult, setTestResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [previousResult, setPreviousResult] = useState(null);
  const [loadingPrev, setLoadingPrev] = useState(true);

  // Lesson completion tracking
  const [completedLessons, setCompletedLessons] = useState([]);

  // Admin / tracker state
  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [adminPin, setAdminPin] = useState("");
  const [allResults, setAllResults] = useState([]);
  const [allProgress, setAllProgress] = useState({});
  const [loadingTracker, setLoadingTracker] = useState(false);

  const isEn = language !== "es";

  // Load previous test result + lesson progress for this staff member
  useEffect(() => {
    if (!staffName) return;
    let isMounted = true;
    const docId = staffName.toLowerCase().replace(/\s+/g, "_");
    // Load test result
    getDoc(doc(db, "training_results", docId))
      .then((snap) => {
        if (isMounted && snap.exists()) setPreviousResult(snap.data());
      })
      .finally(() => {
        if (isMounted) setLoadingPrev(false);
      });
    // Load lesson progress
    getDoc(doc(db, "training_progress", docId))
      .then((snap) => {
        if (isMounted && snap.exists() && snap.data().completedLessons) {
          setCompletedLessons(snap.data().completedLessons);
        }
      });
    return () => { isMounted = false; };
  }, [staffName]);

  /* ─── LESSON COMPLETION ─── */
  const markLessonComplete = async (lessonId) => {
    if (completedLessons.includes(lessonId)) return;
    const updated = [...completedLessons, lessonId];
    setCompletedLessons(updated);
    try {
      const docId = staffName.toLowerCase().replace(/\s+/g, "_");
      await setDoc(doc(db, "training_progress", docId), {
        staffName,
        completedLessons: updated,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (err) {
      console.error("Failed to save lesson progress:", err);
    }
  };

  /* ─── TEST LOGIC ─── */
  const handleAnswer = (qId, value) => {
    setTestAnswers((prev) => ({ ...prev, [qId]: value }));
  };

  const submitTest = async () => {
    setSubmitting(true);
    let correct = 0;
    const details = BOH_TEST.map((q) => {
      const userAnswer = testAnswers[q.id];
      const isCorrect = q.type === "mc"
        ? userAnswer === q.answer
        : userAnswer === q.answer;
      if (isCorrect) correct++;
      return { questionId: q.id, userAnswer, correctAnswer: q.answer, isCorrect };
    });

    const score = correct / BOH_TEST.length;
    const passed = score >= PASS_THRESHOLD;
    const result = {
      staffName,
      module: "boh_basics",
      score: Math.round(score * 100),
      correct,
      total: BOH_TEST.length,
      passed,
      details,
      submittedAt: new Date().toISOString(),
    };

    try {
      const docId = staffName.toLowerCase().replace(/\s+/g, "_");
      // Save latest result (overwrites previous for quick lookup)
      await setDoc(doc(db, "training_results", docId), result);
      // Also save to history subcollection so all attempts are tracked
      await addDoc(collection(db, "training_results", docId, "history"), result);
    } catch (err) {
      console.error("Failed to save training result:", err);
    }

    setTestResult(result);
    setPreviousResult(result);
    setBohView("results");
    setSubmitting(false);
  };

  const retakeTest = () => {
    setTestAnswers({});
    setTestResult(null);
    setBohView("test");
  };

  /* ─── ADMIN / TRACKER ─── */
  const unlockAdmin = async () => {
    // Check PIN against staff list
    const adminNames = ["andrew shih", "julie shih"];
    const staff = (staffList || []).find(s => String(s.pin) === String(adminPin));
    if (staff && adminNames.includes(staff.name.toLowerCase())) {
      setAdminUnlocked(true);
      await loadTrackerData();
    }
  };

  const loadTrackerData = async () => {
    setLoadingTracker(true);
    try {
      // Load all test results
      const resultsSnap = await getDocs(collection(db, "training_results"));
      const results = [];
      resultsSnap.forEach((d) => results.push({ id: d.id, ...d.data() }));
      results.sort((a, b) => (b.submittedAt || "").localeCompare(a.submittedAt || ""));
      setAllResults(results);

      // Load all lesson progress
      const progressSnap = await getDocs(collection(db, "training_progress"));
      const progress = {};
      progressSnap.forEach((d) => { progress[d.id] = d.data(); });
      setAllProgress(progress);
    } catch (err) {
      console.error("Failed to load tracker data:", err);
    }
    setLoadingTracker(false);
  };

  const allAnswered = Object.keys(testAnswers).length === BOH_TEST.length;
  const allLessonsDone = completedLessons.length === BOH_LESSONS.length;

  /* ─── RENDER ─── */
  return (
    <div className="p-4 pb-24">
      {/* Header */}
      <h2 className="text-2xl font-bold text-mint-700 mb-1">
        {"\u{1F4DA}"} {isEn ? "Training Hub" : "Centro de Capacitaci\u00F3n"}
      </h2>
      <p className="text-gray-500 text-sm mb-4">
        {isEn
          ? "Complete your training modules and pass the quiz."
          : "Completa tus m\u00F3dulos de capacitaci\u00F3n y aprueba el examen."}
      </p>

      {/* Main Tabs: FOH / BOH */}
      <div className="flex gap-2 mb-6">
        <button
          onClick={() => setMainTab("foh")}
          className={`flex-1 py-3 rounded-xl font-bold text-lg border-2 transition-all ${
            mainTab === "foh"
              ? "bg-mint-600 text-white border-mint-600"
              : "bg-white text-gray-600 border-gray-200"
          }`}
        >
          {"\u{1F37D}\u{FE0F}"} {isEn ? "Front of House" : "Frente de Casa"}
        </button>
        <button
          onClick={() => setMainTab("boh")}
          className={`flex-1 py-3 rounded-xl font-bold text-lg border-2 transition-all ${
            mainTab === "boh"
              ? "bg-mint-600 text-white border-mint-600"
              : "bg-white text-gray-600 border-gray-200"
          }`}
        >
          {"\u{1F468}\u{200D}\u{1F373}"} {isEn ? "Back of House" : "Cocina"}
        </button>
      </div>

      {/* ─── FOH TAB (Placeholder) ─── */}
      {mainTab === "foh" && (
        <div className="bg-yellow-50 border-2 border-yellow-300 rounded-xl p-8 text-center">
          <p className="text-5xl mb-4">{"\u{1F6A7}"}</p>
          <p className="text-yellow-700 font-bold text-xl mb-2">
            {isEn ? "Coming Soon" : "Pr\u00F3ximamente"}
          </p>
          <p className="text-yellow-600">
            {isEn
              ? "Front of House training is being built. Check back soon!"
              : "La capacitaci\u00F3n de Frente de Casa est\u00E1 en construcci\u00F3n. \u00A1Vuelve pronto!"}
          </p>
        </div>
      )}

      {/* ─── BOH TAB ─── */}
      {mainTab === "boh" && (
        <>
          {/* BOH Sub-tabs */}
          <div className="flex gap-1 mb-4">
            {[
              { key: "lessons", icon: "\u{1F4D6}", en: "Lessons", es: "Lecciones" },
              { key: "test", icon: "\u{1F4DD}", en: "Test", es: "Examen" },
              { key: "results", icon: "\u{1F4CA}", en: "Results", es: "Resultados" },
              { key: "tracker", icon: "\u{1F4CB}", en: "Tracker", es: "Progreso" },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => {
                  setBohView(tab.key);
                  if (tab.key === "tracker" && !adminUnlocked) { /* will show PIN */ }
                }}
                className={`flex-1 py-2 rounded-lg font-bold text-xs border-2 transition-all ${
                  bohView === tab.key
                    ? "bg-green-600 text-white border-green-600"
                    : "bg-white text-gray-500 border-gray-200"
                }`}
              >
                {tab.icon} {isEn ? tab.en : tab.es}
              </button>
            ))}
          </div>

          {/* ─── LESSONS VIEW ─── */}
          {bohView === "lessons" && (
            <div className="space-y-3">
              {/* Progress bar */}
              <div className="bg-white rounded-xl border-2 border-gray-200 p-3 mb-2">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-bold text-gray-700">
                    {isEn ? "Your Progress" : "Tu Progreso"}
                  </span>
                  <span className="text-sm font-bold text-mint-600">
                    {completedLessons.length}/{BOH_LESSONS.length}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-3">
                  <div
                    className="bg-mint-500 h-3 rounded-full transition-all"
                    style={{ width: `${(completedLessons.length / BOH_LESSONS.length) * 100}%` }}
                  />
                </div>
                {allLessonsDone && (
                  <p className="text-green-600 text-xs font-bold mt-1">
                    {"\u2705"} {isEn ? "All lessons complete! Ready for the test." : "\u00A1Todas las lecciones completas! Listo para el examen."}
                  </p>
                )}
              </div>

              <p className="text-gray-600 text-sm mb-2">
                {isEn
                  ? "Review all lessons before taking the test. Tap a lesson to expand, then mark it complete."
                  : "Revisa todas las lecciones antes de tomar el examen. Toca una lecci\u00F3n para expandirla, luego m\u00E1rcala como completada."}
              </p>

              {BOH_LESSONS.map((lesson) => {
                const isDone = completedLessons.includes(lesson.id);
                return (
                  <div
                    key={lesson.id}
                    className={`bg-white rounded-xl border-2 overflow-hidden ${isDone ? "border-green-400" : "border-gray-200"}`}
                  >
                    <button
                      onClick={() => setExpandedLesson(expandedLesson === lesson.id ? null : lesson.id)}
                      className="w-full p-4 flex items-center justify-between text-left"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{isDone ? "\u2705" : lesson.icon}</span>
                        <span className={`font-bold ${isDone ? "text-green-700" : "text-gray-800"}`}>
                          {isEn ? lesson.title : lesson.titleEs}
                        </span>
                      </div>
                      <span className="text-gray-400 text-xl">
                        {expandedLesson === lesson.id ? "\u25B2" : "\u25BC"}
                      </span>
                    </button>
                    {expandedLesson === lesson.id && (
                      <div className="px-4 pb-4 border-t border-gray-100">
                        <div className="mt-3 space-y-2">
                          {(isEn ? lesson.content : lesson.contentEs).map((line, i) => (
                            <p
                              key={i}
                              className={`text-sm ${
                                line === "" ? "h-2"
                                  : line.startsWith("\u{1F53D}") || line.startsWith("\u2022") ? "text-gray-700 pl-2"
                                  : line.match(/^\d\./) ? "text-gray-700 pl-4"
                                  : "text-gray-700"
                              } ${
                                line.includes("WHY") || line.includes("POR QU\u00C9") ||
                                line.includes("Additional") || line.includes("Reglas adicionales") ||
                                line.includes("When to sanitize") || line.includes("Cu\u00E1ndo desinfectar") ||
                                line.includes("BEFORE") || line.includes("ANTES") ||
                                line.includes("Clean-as-you-go") || line.includes("H\u00E1bitos") ||
                                line.includes("You must also") || line.includes("Tambi\u00E9n debes") ||
                                line.includes("Proper handwashing") || line.includes("Pasos correctos") ||
                                line.includes("The 5-step") || line.includes("El proceso") ||
                                line.includes("Why it matters") || line.includes("Por qu\u00E9 es") ||
                                line.includes("Personal hygiene") || line.includes("Reglas de higiene") ||
                                line.includes("Key food safety") || line.includes("Temperaturas clave") ||
                                line.includes("Cross-contamination") || line.includes("Prevenci\u00F3n de contaminaci\u00F3n") ||
                                line.includes("Basic knife") || line.includes("Reglas b\u00E1sicas de seguridad") ||
                                line.includes("Cutting board") || line.includes("Seguridad con tabla") ||
                                line.includes("Storage and washing") || line.includes("Almacenamiento y lavado") ||
                                line.includes("How to practice") || line.includes("C\u00F3mo practicar") ||
                                line.includes("Date labeling") || line.includes("Reglas de etiquetado") ||
                                line.includes("Common FIFO") || line.includes("Errores comunes")
                                  ? "font-bold text-gray-900 mt-2" : ""
                              }`}
                            >
                              {line || "\u00A0"}
                            </p>
                          ))}
                        </div>
                        <div className="mt-4 bg-green-50 border-2 border-green-300 rounded-lg p-3">
                          <p className="text-green-800 font-bold text-sm">
                            {"\u{2B50}"} {isEn ? "Key Takeaway:" : "Punto Clave:"}
                          </p>
                          <p className="text-green-700 text-sm mt-1">
                            {isEn ? lesson.keyPoint : lesson.keyPointEs}
                          </p>
                        </div>
                        {!isDone && (
                          <button
                            onClick={() => markLessonComplete(lesson.id)}
                            className="mt-3 w-full bg-green-600 text-white py-2 rounded-lg font-bold text-sm hover:bg-green-700 transition-all"
                          >
                            {"\u2705"} {isEn ? "Mark as Complete" : "Marcar como Completada"}
                          </button>
                        )}
                        {isDone && (
                          <p className="mt-3 text-center text-green-600 font-bold text-sm">
                            {"\u2705"} {isEn ? "Completed" : "Completada"}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}

              <div className="mt-6 text-center">
                <button
                  onClick={() => setBohView("test")}
                  className="bg-green-600 text-white py-3 px-8 rounded-xl font-bold text-lg shadow-lg hover:bg-green-700 transition-all"
                >
                  {"\u{1F4DD}"} {isEn ? "Ready? Take the Test!" : "\u00BFListo? \u00A1Toma el Examen!"}
                </button>
              </div>
            </div>
          )}

          {/* ─── TEST VIEW ─── */}
          {bohView === "test" && (
            <div className="space-y-4">
              <div className="bg-blue-50 border-2 border-blue-300 rounded-xl p-4 mb-2">
                <p className="text-blue-800 font-bold">
                  {"\u{1F4CB}"} {isEn ? "BOH Food Safety Test \u2014 20 Questions" : "Examen de Seguridad Alimentaria BOH \u2014 20 Preguntas"}
                </p>
                <p className="text-blue-600 text-sm mt-1">
                  {isEn ? "You need 80% (16/20) to pass. Take your time!" : "Necesitas 80% (16/20) para aprobar. \u00A1T\u00F3mate tu tiempo!"}
                </p>
              </div>

              {BOH_TEST.map((q, idx) => (
                <div key={q.id} className="bg-white rounded-xl border-2 border-gray-200 p-4">
                  <p className="font-bold text-gray-800 mb-3">
                    {idx + 1}. {isEn ? q.q : q.qEs}
                  </p>
                  {q.type === "mc" ? (
                    <div className="space-y-2">
                      {(isEn ? q.options : q.optionsEs).map((opt, optIdx) => (
                        <button
                          key={optIdx}
                          onClick={() => handleAnswer(q.id, optIdx)}
                          className={`w-full text-left p-3 rounded-lg border-2 transition-all ${
                            testAnswers[q.id] === optIdx
                              ? "bg-mint-50 border-mint-500 text-mint-800"
                              : "bg-gray-50 border-gray-200 text-gray-700 hover:border-gray-300"
                          }`}
                        >
                          <span className="font-bold mr-2">{String.fromCharCode(65 + optIdx)}.</span>
                          {opt}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="flex gap-3">
                      <button
                        onClick={() => handleAnswer(q.id, true)}
                        className={`flex-1 p-3 rounded-lg border-2 font-bold transition-all ${
                          testAnswers[q.id] === true
                            ? "bg-green-50 border-green-500 text-green-800"
                            : "bg-gray-50 border-gray-200 text-gray-700"
                        }`}
                      >
                        {"\u2705"} {isEn ? "True" : "Verdadero"}
                      </button>
                      <button
                        onClick={() => handleAnswer(q.id, false)}
                        className={`flex-1 p-3 rounded-lg border-2 font-bold transition-all ${
                          testAnswers[q.id] === false
                            ? "bg-red-50 border-red-500 text-red-800"
                            : "bg-gray-50 border-gray-200 text-gray-700"
                        }`}
                      >
                        {"\u274C"} {isEn ? "False" : "Falso"}
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {/* Progress + Submit */}
              <div className="sticky bottom-20 bg-white border-2 border-gray-200 rounded-xl p-4 shadow-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-gray-600 text-sm font-bold">
                    {Object.keys(testAnswers).length}/{BOH_TEST.length} {isEn ? "answered" : "respondidas"}
                  </span>
                  <span className="text-gray-400 text-sm">
                    {isEn ? "Need 16/20 to pass" : "Necesitas 16/20 para aprobar"}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2 mb-3">
                  <div
                    className="bg-mint-500 h-2 rounded-full transition-all"
                    style={{ width: `${(Object.keys(testAnswers).length / BOH_TEST.length) * 100}%` }}
                  />
                </div>
                <button
                  onClick={submitTest}
                  disabled={!allAnswered || submitting}
                  className={`w-full py-3 rounded-xl font-bold text-lg transition-all ${
                    allAnswered && !submitting
                      ? "bg-green-600 text-white shadow-lg hover:bg-green-700"
                      : "bg-gray-300 text-gray-500 cursor-not-allowed"
                  }`}
                >
                  {submitting ? (isEn ? "Submitting..." : "Enviando...") : (isEn ? "Submit Test" : "Enviar Examen")}
                </button>
              </div>
            </div>
          )}

          {/* ─── RESULTS VIEW ─── */}
          {bohView === "results" && (
            <div>
              {/* Show current test result if just submitted */}
              {testResult && (
                <div className={`rounded-xl border-2 p-6 text-center mb-6 ${testResult.passed ? "bg-green-50 border-green-400" : "bg-red-50 border-red-400"}`}>
                  <p className="text-5xl mb-3">{testResult.passed ? "\u{1F389}" : "\u{1F4AA}"}</p>
                  <p className={`text-2xl font-bold mb-2 ${testResult.passed ? "text-green-700" : "text-red-700"}`}>
                    {testResult.passed ? (isEn ? "You Passed!" : "\u00A1Aprobaste!") : (isEn ? "Not Yet \u2014 Keep Trying!" : "\u00A1A\u00FAn no \u2014 Sigue intentando!")}
                  </p>
                  <p className="text-3xl font-bold text-gray-800 mb-1">{testResult.score}%</p>
                  <p className="text-gray-600">{testResult.correct}/{testResult.total} {isEn ? "correct" : "correctas"}</p>

                  {testResult.details.some((d) => !d.isCorrect) && (
                    <div className="mt-4 text-left">
                      <p className="font-bold text-gray-700 mb-2">
                        {isEn ? "Review incorrect answers:" : "Revisa respuestas incorrectas:"}
                      </p>
                      {testResult.details.filter((d) => !d.isCorrect).map((d) => {
                        const q = BOH_TEST.find((t) => t.id === d.questionId);
                        return (
                          <div key={d.questionId} className="bg-white rounded-lg border border-red-200 p-3 mb-2">
                            <p className="text-sm text-gray-800 font-bold">Q{d.questionId}: {isEn ? q.q : q.qEs}</p>
                            <p className="text-sm text-red-600 mt-1">
                              {isEn ? "Correct answer: " : "Respuesta correcta: "}
                              {q.type === "mc"
                                ? (isEn ? q.options : q.optionsEs)[q.answer]
                                : q.answer ? (isEn ? "True" : "Verdadero") : (isEn ? "False" : "Falso")}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {!testResult.passed && (
                    <button onClick={retakeTest} className="mt-4 bg-mint-600 text-white py-3 px-8 rounded-xl font-bold text-lg shadow-lg hover:bg-mint-700 transition-all">
                      {"\u{1F504}"} {isEn ? "Retake Test" : "Repetir Examen"}
                    </button>
                  )}
                </div>
              )}

              {/* Show previous result if no current test */}
              {!testResult && previousResult && (
                <div className={`rounded-xl border-2 p-6 text-center mb-6 ${previousResult.passed ? "bg-green-50 border-green-400" : "bg-yellow-50 border-yellow-400"}`}>
                  <p className="text-4xl mb-3">{previousResult.passed ? "\u2705" : "\u{1F4CB}"}</p>
                  <p className="font-bold text-lg text-gray-800 mb-1">{isEn ? "Your Last Result" : "Tu \u00DAltimo Resultado"}</p>
                  <p className="text-3xl font-bold text-gray-800 mb-1">{previousResult.score}%</p>
                  <p className="text-gray-600 mb-1">{previousResult.correct}/{previousResult.total} {isEn ? "correct" : "correctas"}</p>
                  <p className="text-gray-400 text-xs">{isEn ? "Submitted: " : "Enviado: "}{new Date(previousResult.submittedAt).toLocaleDateString()}</p>
                  <button onClick={retakeTest} className="mt-4 bg-mint-600 text-white py-3 px-6 rounded-xl font-bold shadow-lg">
                    {"\u{1F504}"} {isEn ? "Retake Test" : "Repetir Examen"}
                  </button>
                </div>
              )}

              {!testResult && !previousResult && !loadingPrev && (
                <div className="bg-gray-50 border-2 border-gray-200 rounded-xl p-6 text-center">
                  <p className="text-gray-500">
                    {isEn ? "No test results yet. Take the test first!" : "\u00A1A\u00FAn no hay resultados. Toma el examen primero!"}
                  </p>
                  <button onClick={() => setBohView("test")} className="mt-3 bg-green-600 text-white py-2 px-6 rounded-xl font-bold">
                    {isEn ? "Take Test" : "Tomar Examen"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ─── TRACKER VIEW (Admin) ─── */}
          {bohView === "tracker" && (
            <div>
              {!adminUnlocked ? (
                <div className="bg-gray-50 border-2 border-gray-200 rounded-xl p-6 text-center">
                  <p className="text-2xl mb-3">{"\u{1F512}"}</p>
                  <p className="font-bold text-gray-700 mb-3">
                    {isEn ? "Manager Access Required" : "Se Requiere Acceso de Gerente"}
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <input
                      type="password"
                      value={adminPin}
                      onChange={(e) => setAdminPin(e.target.value)}
                      placeholder={isEn ? "Enter PIN" : "Ingresa PIN"}
                      className="w-32 p-3 border-2 border-gray-300 rounded-lg text-center font-bold text-lg"
                      onKeyDown={(e) => e.key === "Enter" && unlockAdmin()}
                    />
                    <button
                      onClick={unlockAdmin}
                      className="bg-mint-600 text-white py-3 px-5 rounded-lg font-bold text-sm hover:bg-mint-700 transition-all"
                    >
                      {isEn ? "Unlock" : "Desbloquear"}
                    </button>
                  </div>
                  <p className="text-gray-400 text-xs mt-2">
                    {isEn ? "Use your admin PIN" : "Usa tu PIN de admin"}
                  </p>
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="font-bold text-lg text-gray-800">
                      {"\u{1F4CB}"} {isEn ? "Staff Training Tracker" : "Progreso de Capacitaci\u00F3n"}
                    </h3>
                    <button
                      onClick={loadTrackerData}
                      className="bg-gray-200 text-gray-600 py-1 px-3 rounded-lg text-sm font-bold"
                    >
                      {"\u{1F504}"} {isEn ? "Refresh" : "Actualizar"}
                    </button>
                  </div>

                  {loadingTracker ? (
                    <p className="text-gray-400 text-center py-4">{isEn ? "Loading..." : "Cargando..."}</p>
                  ) : (
                    <>
                      {/* Summary counts */}
                      <div className="grid grid-cols-3 gap-2 mb-4">
                        <div className="bg-green-50 border-2 border-green-300 rounded-lg p-3 text-center">
                          <p className="text-2xl font-bold text-green-700">
                            {allResults.filter(r => r.passed).length}
                          </p>
                          <p className="text-xs text-green-600 font-bold">{isEn ? "Passed" : "Aprobados"}</p>
                        </div>
                        <div className="bg-red-50 border-2 border-red-300 rounded-lg p-3 text-center">
                          <p className="text-2xl font-bold text-red-700">
                            {allResults.filter(r => !r.passed).length}
                          </p>
                          <p className="text-xs text-red-600 font-bold">{isEn ? "Failed" : "Reprobados"}</p>
                        </div>
                        <div className="bg-gray-50 border-2 border-gray-300 rounded-lg p-3 text-center">
                          <p className="text-2xl font-bold text-gray-700">
                            {(staffList || []).length - allResults.length}
                          </p>
                          <p className="text-xs text-gray-600 font-bold">{isEn ? "Not Started" : "Sin Iniciar"}</p>
                        </div>
                      </div>

                      {/* Staff checklist */}
                      <div className="space-y-2">
                        {(staffList || []).map((staff) => {
                          const docId = staff.name.toLowerCase().replace(/\s+/g, "_");
                          const result = allResults.find(r => r.id === docId);
                          const progress = allProgress[docId];
                          const lessonsCompleted = progress?.completedLessons?.length || 0;
                          const hasTest = !!result;
                          const passed = result?.passed;

                          return (
                            <div
                              key={staff.name}
                              className={`p-3 rounded-lg border-2 ${
                                passed ? "bg-green-50 border-green-300"
                                : hasTest ? "bg-red-50 border-red-300"
                                : lessonsCompleted > 0 ? "bg-yellow-50 border-yellow-300"
                                : "bg-gray-50 border-gray-200"
                              }`}
                            >
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="font-bold text-gray-800">{staff.name}</p>
                                  <div className="flex items-center gap-3 mt-1">
                                    <span className="text-xs text-gray-500">
                                      {"\u{1F4D6}"} {lessonsCompleted}/{BOH_LESSONS.length} {isEn ? "lessons" : "lecciones"}
                                    </span>
                                    {hasTest && (
                                      <span className={`text-xs font-bold ${passed ? "text-green-600" : "text-red-600"}`}>
                                        {"\u{1F4DD}"} {result.score}% {passed ? (isEn ? "Passed" : "Aprobado") : (isEn ? "Failed" : "Reprobado")}
                                      </span>
                                    )}
                                    {!hasTest && (
                                      <span className="text-xs text-gray-400">
                                        {"\u{1F4DD}"} {isEn ? "No test yet" : "Sin examen"}
                                      </span>
                                    )}
                                  </div>
                                  {hasTest && (
                                    <p className="text-xs text-gray-400 mt-1">
                                      {new Date(result.submittedAt).toLocaleDateString()}
                                    </p>
                                  )}
                                </div>
                                <div className="text-right">
                                  {passed ? (
                                    <span className="text-2xl">{"\u2705"}</span>
                                  ) : hasTest ? (
                                    <span className="text-2xl">{"\u274C"}</span>
                                  ) : lessonsCompleted > 0 ? (
                                    <span className="text-2xl">{"\u{1F7E1}"}</span>
                                  ) : (
                                    <span className="text-2xl">{"\u2B1C"}</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Legend */}
                      <div className="mt-4 bg-white border border-gray-200 rounded-lg p-3">
                        <p className="text-xs font-bold text-gray-600 mb-1">{isEn ? "Legend:" : "Leyenda:"}</p>
                        <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                          <span>{"\u2705"} {isEn ? "Passed" : "Aprobado"}</span>
                          <span>{"\u274C"} {isEn ? "Failed" : "Reprobado"}</span>
                          <span>{"\u{1F7E1}"} {isEn ? "In Progress" : "En Progreso"}</span>
                          <span>{"\u2B1C"} {isEn ? "Not Started" : "Sin Iniciar"}</span>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
