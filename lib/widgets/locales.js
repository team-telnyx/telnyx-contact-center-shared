const ENGLISH = {
  content: {
    title: "How can we help?",
    messagingSubtitle: "Chat with our team",
    voiceSubtitle: "Voice call with an AI assistant",
    welcomeMessage: "Hello! How can I help?",
    chatLabel: "Chat with us",
    callLabel: "Call us",
    inputPlaceholder: "Type your message…",
    connectingMessage: "Connecting…",
    assistantTypingMessage: "The assistant is replying…",
    agentTypingMessage: "The agent is typing…",
    sendingMessage: "Sending…",
    handoffWaitingMessage: "Transferring the conversation to the {queue} queue.",
    handoffAssignedMessage: "Agent {agent} has been assigned to the conversation.",
    handoffConnectedMessage: "Agent {agent} has joined the conversation.",
    handoffDisconnectedMessage: "Agent {agent} ended the chat. This session is now closed.", handoffFailedMessage: "The conversation could not be transferred to an agent.",
    unavailableMessage: "Chat is temporarily unavailable. Please try again later.",
    sendFailedMessage: "The message could not be sent. Please try again.",
    voiceReadyMessage: "Ready to start the call.",
    voiceConnectingMessage: "Connecting to the voice assistant…",
    voiceActiveMessage: "Call active",
    voiceListeningMessage: "listening",
    voiceThinkingMessage: "thinking",
    voiceSpeakingMessage: "speaking",
    voiceEndedMessage: "Call ended.",
    voiceErrorMessage: "The call could not be started. Check microphone access and try again.",
    startCallLabel: "Start call",
    endCallLabel: "End call",
    muteLabel: "Mute microphone",
    unmuteLabel: "Unmute microphone",
    videoLabel: "Voice & Video Call",
    videoSubtitle: "Talk to an agent over video",
    videoWaitingMessage: "Please wait, we are connecting you with an agent.",
    videoConnectingMessage: "Connecting your video call…",
    videoActiveMessage: "Call in progress",
    videoEndedMessage: "The video call has ended.",
    videoErrorMessage: "The video call could not be started. Check camera and microphone access and try again.",
    joinVideoLabel: "Start call",
    cameraOnLabel: "Turn camera on",
    cameraOffLabel: "Turn camera off",
  },
  video: {
    layoutRemote: "Agent only", layoutSplit: "Side by side", layoutPip: "Picture in picture",
    cameraPreview: "Camera preview", cameraOff: "Camera is off", agentCameraOff: "The agent's camera is off",
    waitingForAgent: "Waiting for an agent", queuePosition: "You are in the {queue} queue", agentJoining: "{agent} is joining…",
    you: "You", agent: "Agent", leave: "Leave call", switchCamera: "Camera", microphone: "Microphone", layout: "Layout",
    recordingNotice: "This call may be recorded.", reconnecting: "Reconnecting…",
    expand: "Enlarge video", collapse: "Exit enlarged video",
    layoutSpotlight: "Spotlight", shareScreen: "Share your screen", stopSharing: "Stop sharing", screen: "Screen", supervisor: "Supervisor",
    hiddenParticipants: "+{count} more",
  },
  labels: { assistant: "AI Assistant", human: "Agent", customer: "You" },
  actions: { startNewConversation: "Start a new conversation" },
  launcherLabel: "Contact us",
  headsUp: { headline: "Hi there! 👋", body: "Our team is here to help. How can we assist you?" },
  preview: {
    userOrder: "I need help with my order.", assistantReply: "Of course — I can help with that.",
    handoffRequest: "I would like to speak to an agent.", humanReply: "Hello, I can take it from here.",
    voiceRequest: "I would like to speak with Sales.", voiceReply: "Sure. I can connect you with the right queue.",
    attachment: "Attachment", file: "file", fallbackQueue: "Customer Service", fallbackAgent: "Human agent",
    delivered: "Delivered", handoffStatus: "Contact Center handoff status",
    simulateAttachment: "Simulate an allowed customer attachment", photoAttached: "Photo attached", documentAttached: "Document attached",
    noInlinePreview: "This file type cannot be shown here. Download it to open the file.",
    attachmentTypeRejected: "This file type is not accepted.", attachmentTooLarge: "Files must be {limit} MB or smaller.",
    attachmentFailed: "The file could not be sent. Please try again.",
  },
  aria: {
    home: "Home", close: "Close", send: "Send", attachFile: "Attach file", attachmentUnavailable: "Files can be shared once an agent joins",
    downloadAttachment: "Download attachment", openAttachment: "Open in a new tab",
    emoji: "Emoji", resumeSpeaker: "Resume speaker", muteSpeaker: "Mute speaker", loading: "Loading widget…",
    avatarTitle: "Avatar", avatarExpand: "Expand avatar", avatarCollapse: "Exit expanded avatar", avatarTranscript: "Transcription", connectCall: "Connect", disconnectCall: "Disconnect", holdCall: "Hold call", resumeCall: "Resume call",
  },
};

const TRANSLATIONS = {
  "en-US": ENGLISH,
  "en-GB": ENGLISH,
  "pl-PL": {
    video: {
      layoutRemote: "Tylko konsultant", layoutSplit: "Obok siebie", layoutPip: "Obraz w obrazie",
      cameraPreview: "Podgląd kamery", cameraOff: "Kamera jest wyłączona", agentCameraOff: "Kamera konsultanta jest wyłączona",
      waitingForAgent: "Oczekiwanie na konsultanta", queuePosition: "Jesteś w kolejce {queue}", agentJoining: "{agent} dołącza…",
      you: "Ty", agent: "Konsultant", leave: "Zakończ rozmowę", switchCamera: "Kamera", microphone: "Mikrofon", layout: "Układ",
      recordingNotice: "Ta rozmowa może być nagrywana.", reconnecting: "Ponowne łączenie…",
      expand: "Powiększ wideo", collapse: "Zamknij powiększone wideo",
      layoutSpotlight: "Scena główna", shareScreen: "Udostępnij ekran", stopSharing: "Zakończ udostępnianie", screen: "Ekran", supervisor: "Supervisor",
      hiddenParticipants: "+{count} więcej",
    },
    content: {
      title: "Jak możemy pomóc?", messagingSubtitle: "Rozmowa z konsultantem", voiceSubtitle: "Połączenie głosowe z asystentem AI",
      welcomeMessage: "Dzień dobry! W czym mogę pomóc?", chatLabel: "Napisz do nas", callLabel: "Zadzwoń do nas", inputPlaceholder: "Napisz wiadomość…",
      connectingMessage: "Łączenie…", assistantTypingMessage: "Asystent odpowiada…", agentTypingMessage: "Konsultant pisze…", sendingMessage: "Wysyłanie…",
      handoffWaitingMessage: "Przekazujemy rozmowę do kolejki {queue}.", handoffAssignedMessage: "Konsultant {agent} został przydzielony do rozmowy.",
      handoffConnectedMessage: "Konsultant {agent} dołączył do rozmowy.", handoffDisconnectedMessage: "Konsultant {agent} zakończył rozmowę. Ta sesja czatu jest już zamknięta.", handoffFailedMessage: "Nie udało się przekazać rozmowy do konsultanta.",
      unavailableMessage: "Czat jest chwilowo niedostępny. Spróbuj ponownie później.", sendFailedMessage: "Nie udało się wysłać wiadomości. Spróbuj ponownie.",
      voiceReadyMessage: "Gotowi do rozpoczęcia rozmowy.", voiceConnectingMessage: "Łączenie z asystentem głosowym…", voiceActiveMessage: "Połączenie aktywne",
      voiceListeningMessage: "słucham", voiceThinkingMessage: "analizuję", voiceSpeakingMessage: "odpowiadam", voiceEndedMessage: "Połączenie zakończone.",
      voiceErrorMessage: "Nie udało się rozpocząć połączenia. Sprawdź dostęp do mikrofonu i spróbuj ponownie.",
      startCallLabel: "Rozpocznij połączenie", endCallLabel: "Zakończ połączenie", muteLabel: "Wycisz mikrofon", unmuteLabel: "Włącz mikrofon",
      videoLabel: "Rozmowa głosowa i wideo",
      videoSubtitle: "Połącz się z konsultantem przez wideo",
      videoWaitingMessage: "Proszę czekać, łączymy z konsultantem.",
      videoConnectingMessage: "Łączenie rozmowy wideo…",
      videoActiveMessage: "Rozmowa w toku",
      videoEndedMessage: "Rozmowa wideo została zakończona.",
      videoErrorMessage: "Nie udało się rozpocząć rozmowy wideo. Sprawdź dostęp do kamery i mikrofonu i spróbuj ponownie.",
      joinVideoLabel: "Rozpocznij rozmowę",
      cameraOnLabel: "Włącz kamerę",
      cameraOffLabel: "Wyłącz kamerę",
    },
    labels: { assistant: "Asystent AI", human: "Konsultant", customer: "Ty" }, launcherLabel: "Skontaktuj się z nami",
    actions: { startNewConversation: "Rozpocznij nową rozmowę" },
    headsUp: { headline: "Dzień dobry! 👋", body: "Nasz zespół jest tutaj, aby pomóc. W czym możemy pomóc?" },
    preview: {
      userOrder: "Potrzebuję pomocy z zamówieniem.", assistantReply: "Oczywiście — chętnie pomogę.", handoffRequest: "Chcę porozmawiać z konsultantem.",
      humanReply: "Dzień dobry, przejmuję rozmowę.", voiceRequest: "Chcę porozmawiać z działem sprzedaży.", voiceReply: "Jasne. Połączę Cię z właściwą kolejką.",
      attachment: "Załącznik", file: "plik", fallbackQueue: "Obsługa klienta", fallbackAgent: "Konsultant", delivered: "Dostarczono",
      handoffStatus: "Status przekazania do Contact Center", simulateAttachment: "Zasymuluj dozwolony załącznik klienta", photoAttached: "Zdjęcie załączone", documentAttached: "Dokument załączony", noInlinePreview: "Tego typu pliku nie można wyświetlić tutaj. Pobierz go, aby otworzyć.", attachmentTypeRejected: "Ten typ pliku nie jest akceptowany.", attachmentTooLarge: "Pliki mogą mieć maksymalnie {limit} MB.", attachmentFailed: "Nie udało się wysłać pliku. Spróbuj ponownie.",
    },
    aria: { home: "Strona główna", close: "Zamknij", send: "Wyślij", attachFile: "Dodaj plik", attachmentUnavailable: "Pliki można przesyłać po dołączeniu konsultanta", downloadAttachment: "Pobierz załącznik", openAttachment: "Otwórz w nowej karcie", emoji: "Emoji", resumeSpeaker: "Włącz głośnik", muteSpeaker: "Wycisz głośnik", loading: "Ładowanie widgeta…", avatarTitle: "Awatar", avatarExpand: "Powiększ awatara", avatarCollapse: "Zamknij powiększony widok", avatarTranscript: "Transkrypcja", connectCall: "Połącz", disconnectCall: "Rozłącz", holdCall: "Wstrzymaj", resumeCall: "Wznów" },
  },
  "de-DE": {
    content: {
      title: "Wie können wir helfen?", messagingSubtitle: "Chat mit unserem Team", voiceSubtitle: "Sprachanruf mit einem KI-Assistenten",
      welcomeMessage: "Hallo! Wie kann ich helfen?", chatLabel: "Mit uns chatten", callLabel: "Uns anrufen", inputPlaceholder: "Nachricht eingeben…",
      connectingMessage: "Verbindung wird hergestellt…", assistantTypingMessage: "Der Assistent antwortet…", agentTypingMessage: "Der Agent schreibt…", sendingMessage: "Wird gesendet…",
      handoffWaitingMessage: "Das Gespräch wird an die Warteschlange {queue} weitergeleitet.", handoffAssignedMessage: "Agent {agent} wurde dem Gespräch zugewiesen.",
      handoffConnectedMessage: "Agent {agent} ist dem Gespräch beigetreten.", handoffDisconnectedMessage: "Agent {agent} hat den Chat beendet. Diese Sitzung ist jetzt geschlossen.", handoffFailedMessage: "Das Gespräch konnte nicht an einen Agenten weitergeleitet werden.",
      unavailableMessage: "Der Chat ist vorübergehend nicht verfügbar. Bitte versuchen Sie es später erneut.", sendFailedMessage: "Die Nachricht konnte nicht gesendet werden. Bitte versuchen Sie es erneut.",
      voiceReadyMessage: "Bereit, den Anruf zu starten.", voiceConnectingMessage: "Verbindung zum Sprachassistenten…", voiceActiveMessage: "Anruf aktiv",
      voiceListeningMessage: "hört zu", voiceThinkingMessage: "denkt nach", voiceSpeakingMessage: "spricht", voiceEndedMessage: "Anruf beendet.",
      voiceErrorMessage: "Der Anruf konnte nicht gestartet werden. Prüfen Sie den Mikrofonzugriff und versuchen Sie es erneut.",
      startCallLabel: "Anruf starten", endCallLabel: "Anruf beenden", muteLabel: "Mikrofon stummschalten", unmuteLabel: "Mikrofon einschalten",
    },
    labels: { assistant: "KI-Assistent", human: "Agent", customer: "Sie" }, launcherLabel: "Kontakt",
    actions: { startNewConversation: "Neues Gespräch beginnen" },
    headsUp: { headline: "Hallo! 👋", body: "Unser Team hilft Ihnen gerne. Wie können wir helfen?" },
    preview: { userOrder: "Ich benötige Hilfe mit meiner Bestellung.", assistantReply: "Natürlich — ich helfe gerne.", handoffRequest: "Ich möchte mit einem Agenten sprechen.", humanReply: "Hallo, ich übernehme ab hier.", voiceRequest: "Ich möchte mit dem Vertrieb sprechen.", voiceReply: "Gerne. Ich verbinde Sie mit der richtigen Warteschlange.", attachment: "Anhang", file: "Datei", fallbackQueue: "Kundenservice", fallbackAgent: "Agent", delivered: "Zugestellt", handoffStatus: "Contact Center-Cloud-Übergabestatus", simulateAttachment: "Zulässigen Kundenanhang simulieren", photoAttached: "Foto angehängt", documentAttached: "Dokument angehängt", noInlinePreview: "Dieser Dateityp kann hier nicht angezeigt werden. Laden Sie ihn herunter, um ihn zu öffnen.", attachmentTypeRejected: "Dieser Dateityp wird nicht akzeptiert.", attachmentTooLarge: "Dateien dürfen höchstens {limit} MB groß sein.", attachmentFailed: "Die Datei konnte nicht gesendet werden. Bitte erneut versuchen.", },
    aria: { home: "Startseite", close: "Schließen", send: "Senden", attachFile: "Datei anhängen", attachmentUnavailable: "Dateien können geteilt werden, sobald ein Agent beitritt", downloadAttachment: "Anhang herunterladen", openAttachment: "In neuem Tab öffnen", emoji: "Emoji", resumeSpeaker: "Lautsprecher einschalten", muteSpeaker: "Lautsprecher stummschalten", loading: "Widget wird geladen…", avatarTitle: "Avatar", avatarExpand: "Avatar vergrößern", avatarCollapse: "Vergrößerte Ansicht schließen", avatarTranscript: "Transkription", connectCall: "Verbinden", disconnectCall: "Trennen", holdCall: "Anruf halten", resumeCall: "Fortsetzen" },
  },
  "fr-FR": {
    content: {
      title: "Comment pouvons-nous vous aider ?", messagingSubtitle: "Discuter avec notre équipe", voiceSubtitle: "Appel vocal avec un assistant IA",
      welcomeMessage: "Bonjour ! Comment puis-je vous aider ?", chatLabel: "Discuter avec nous", callLabel: "Nous appeler", inputPlaceholder: "Écrivez votre message…",
      connectingMessage: "Connexion…", assistantTypingMessage: "L’assistant répond…", agentTypingMessage: "Le conseiller écrit…", sendingMessage: "Envoi…",
      handoffWaitingMessage: "Transfert de la conversation vers la file {queue}.", handoffAssignedMessage: "L’agent {agent} a été affecté à la conversation.",
      handoffConnectedMessage: "L’agent {agent} a rejoint la conversation.", handoffDisconnectedMessage: "Le conseiller {agent} a mis fin au chat. Cette session est désormais close.", handoffFailedMessage: "La conversation n’a pas pu être transférée à un agent.",
      unavailableMessage: "Le chat est temporairement indisponible. Réessayez plus tard.", sendFailedMessage: "Le message n’a pas pu être envoyé. Réessayez.",
      voiceReadyMessage: "Prêt à démarrer l’appel.", voiceConnectingMessage: "Connexion à l’assistant vocal…", voiceActiveMessage: "Appel en cours",
      voiceListeningMessage: "écoute", voiceThinkingMessage: "réflexion", voiceSpeakingMessage: "parle", voiceEndedMessage: "Appel terminé.",
      voiceErrorMessage: "Impossible de démarrer l’appel. Vérifiez l’accès au microphone et réessayez.",
      startCallLabel: "Démarrer l’appel", endCallLabel: "Terminer l’appel", muteLabel: "Couper le microphone", unmuteLabel: "Activer le microphone",
    },
    labels: { assistant: "Assistant IA", human: "Conseiller", customer: "Vous" }, launcherLabel: "Nous contacter",
    actions: { startNewConversation: "Démarrer une nouvelle conversation" },
    headsUp: { headline: "Bonjour ! 👋", body: "Notre équipe est là pour vous aider. Que pouvons-nous faire pour vous ?" },
    preview: { userOrder: "J’ai besoin d’aide avec ma commande.", assistantReply: "Bien sûr — je peux vous aider.", handoffRequest: "Je souhaite parler à un conseiller.", humanReply: "Bonjour, je prends le relais.", voiceRequest: "Je souhaite parler au service commercial.", voiceReply: "Bien sûr. Je vous mets en relation avec la bonne file.", attachment: "Pièce jointe", file: "fichier", fallbackQueue: "Service client", fallbackAgent: "Conseiller", delivered: "Distribué", handoffStatus: "État du transfert Contact Center", simulateAttachment: "Simuler une pièce jointe client autorisée", photoAttached: "Photo jointe", documentAttached: "Document joint", noInlinePreview: "Ce type de fichier ne peut pas être affiché ici. Téléchargez-le pour l’ouvrir.", attachmentTypeRejected: "Ce type de fichier n’est pas accepté.", attachmentTooLarge: "Les fichiers ne doivent pas dépasser {limit} Mo.", attachmentFailed: "Le fichier n’a pas pu être envoyé. Veuillez réessayer.", },
    aria: { home: "Accueil", close: "Fermer", send: "Envoyer", attachFile: "Joindre un fichier", attachmentUnavailable: "Les fichiers peuvent être partagés dès qu’un conseiller rejoint", downloadAttachment: "Télécharger la pièce jointe", openAttachment: "Ouvrir dans un nouvel onglet", emoji: "Emoji", resumeSpeaker: "Activer le haut-parleur", muteSpeaker: "Couper le haut-parleur", loading: "Chargement du widget…", avatarTitle: "Avatar", avatarExpand: "Agrandir l’avatar", avatarCollapse: "Quitter la vue agrandie", avatarTranscript: "Transcription", connectCall: "Connecter", disconnectCall: "Déconnecter", holdCall: "Mettre en attente", resumeCall: "Reprendre" },
  },
  "es-ES": {
    content: {
      title: "¿Cómo podemos ayudarte?", messagingSubtitle: "Chat con nuestro equipo", voiceSubtitle: "Llamada de voz con un asistente de IA",
      welcomeMessage: "¡Hola! ¿Cómo puedo ayudarte?", chatLabel: "Chatea con nosotros", callLabel: "Llámanos", inputPlaceholder: "Escribe tu mensaje…",
      connectingMessage: "Conectando…", assistantTypingMessage: "El asistente está respondiendo…", agentTypingMessage: "El agente está escribiendo…", sendingMessage: "Enviando…",
      handoffWaitingMessage: "Transfiriendo la conversación a la cola {queue}.", handoffAssignedMessage: "El agente {agent} ha sido asignado a la conversación.",
      handoffConnectedMessage: "El agente {agent} se ha unido a la conversación.", handoffDisconnectedMessage: "El agente {agent} finalizó el chat. Esta sesión está cerrada.", handoffFailedMessage: "No se pudo transferir la conversación a un agente.",
      unavailableMessage: "El chat no está disponible temporalmente. Inténtalo más tarde.", sendFailedMessage: "No se pudo enviar el mensaje. Inténtalo de nuevo.",
      voiceReadyMessage: "Listo para iniciar la llamada.", voiceConnectingMessage: "Conectando con el asistente de voz…", voiceActiveMessage: "Llamada activa",
      voiceListeningMessage: "escuchando", voiceThinkingMessage: "pensando", voiceSpeakingMessage: "hablando", voiceEndedMessage: "Llamada finalizada.",
      voiceErrorMessage: "No se pudo iniciar la llamada. Comprueba el acceso al micrófono e inténtalo de nuevo.",
      startCallLabel: "Iniciar llamada", endCallLabel: "Finalizar llamada", muteLabel: "Silenciar micrófono", unmuteLabel: "Activar micrófono",
    },
    labels: { assistant: "Asistente de IA", human: "Agente", customer: "Tú" }, launcherLabel: "Contáctanos",
    actions: { startNewConversation: "Iniciar una nueva conversación" },
    headsUp: { headline: "¡Hola! 👋", body: "Nuestro equipo está aquí para ayudarte. ¿En qué podemos ayudarte?" },
    preview: { userOrder: "Necesito ayuda con mi pedido.", assistantReply: "Por supuesto, puedo ayudarte.", handoffRequest: "Quiero hablar con un agente.", humanReply: "Hola, me encargo a partir de aquí.", voiceRequest: "Quiero hablar con Ventas.", voiceReply: "Claro. Te conectaré con la cola adecuada.", attachment: "Adjunto", file: "archivo", fallbackQueue: "Atención al cliente", fallbackAgent: "Agente", delivered: "Entregado", handoffStatus: "Estado de transferencia de Contact Center", simulateAttachment: "Simular un archivo adjunto permitido", photoAttached: "Foto adjunta", documentAttached: "Documento adjunto", noInlinePreview: "Este tipo de archivo no se puede mostrar aquí. Descárgalo para abrirlo.", attachmentTypeRejected: "Este tipo de archivo no se acepta.", attachmentTooLarge: "Los archivos deben ocupar {limit} MB o menos.", attachmentFailed: "No se pudo enviar el archivo. Inténtalo de nuevo.", },
    aria: { home: "Inicio", close: "Cerrar", send: "Enviar", attachFile: "Adjuntar archivo", attachmentUnavailable: "Los archivos se pueden compartir cuando se une un agente", downloadAttachment: "Descargar adjunto", openAttachment: "Abrir en una pestaña nueva", emoji: "Emoji", resumeSpeaker: "Activar altavoz", muteSpeaker: "Silenciar altavoz", loading: "Cargando widget…", avatarTitle: "Avatar", avatarExpand: "Ampliar avatar", avatarCollapse: "Salir de la vista ampliada", avatarTranscript: "Transcripción", connectCall: "Conectar", disconnectCall: "Desconectar", holdCall: "Poner en espera", resumeCall: "Reanudar" },
  },
  "ar-SA": {
    content: {
      title: "كيف يمكننا مساعدتك؟", messagingSubtitle: "الدردشة مع فريقنا", voiceSubtitle: "مكالمة صوتية مع مساعد ذكي",
      welcomeMessage: "مرحبًا! كيف يمكنني مساعدتك؟", chatLabel: "تحدث معنا", callLabel: "اتصل بنا", inputPlaceholder: "اكتب رسالتك…",
      connectingMessage: "جارٍ الاتصال…", assistantTypingMessage: "المساعد يكتب…", agentTypingMessage: "الموظف يكتب…", sendingMessage: "جارٍ الإرسال…",
      handoffWaitingMessage: "جارٍ تحويل المحادثة إلى قائمة انتظار {queue}.", handoffAssignedMessage: "تم تعيين الموظف {agent} للمحادثة.",
      handoffConnectedMessage: "انضم الموظف {agent} إلى المحادثة.", handoffDisconnectedMessage: "أنهى الموظف {agent} المحادثة. هذه الجلسة مغلقة الآن.", handoffFailedMessage: "تعذر تحويل المحادثة إلى موظف.",
      unavailableMessage: "الدردشة غير متاحة مؤقتًا. يرجى المحاولة لاحقًا.", sendFailedMessage: "تعذر إرسال الرسالة. يرجى المحاولة مرة أخرى.",
      voiceReadyMessage: "جاهز لبدء المكالمة.", voiceConnectingMessage: "جارٍ الاتصال بالمساعد الصوتي…", voiceActiveMessage: "المكالمة نشطة",
      voiceListeningMessage: "يستمع", voiceThinkingMessage: "يفكر", voiceSpeakingMessage: "يتحدث", voiceEndedMessage: "انتهت المكالمة.",
      voiceErrorMessage: "تعذر بدء المكالمة. تحقق من إذن الميكروفون وحاول مرة أخرى.",
      startCallLabel: "بدء المكالمة", endCallLabel: "إنهاء المكالمة", muteLabel: "كتم الميكروفون", unmuteLabel: "تشغيل الميكروفون",
    },
    labels: { assistant: "المساعد الذكي", human: "الموظف", customer: "أنت" }, launcherLabel: "تواصل معنا",
    actions: { startNewConversation: "بدء محادثة جديدة" },
    headsUp: { headline: "مرحبًا! 👋", body: "فريقنا هنا لمساعدتك. كيف يمكننا خدمتك؟" },
    preview: { userOrder: "أحتاج إلى مساعدة بخصوص طلبي.", assistantReply: "بالتأكيد، يمكنني مساعدتك.", handoffRequest: "أرغب في التحدث إلى موظف.", humanReply: "مرحبًا، سأتولى المحادثة من هنا.", voiceRequest: "أرغب في التحدث إلى قسم المبيعات.", voiceReply: "بالتأكيد. سأصلك بقائمة الانتظار المناسبة.", attachment: "مرفق", file: "ملف", fallbackQueue: "خدمة العملاء", fallbackAgent: "الموظف", delivered: "تم التسليم", handoffStatus: "حالة التحويل إلى Contact Center", simulateAttachment: "محاكاة مرفق عميل مسموح", photoAttached: "تم إرفاق صورة", documentAttached: "تم إرفاق مستند", noInlinePreview: "لا يمكن عرض هذا النوع من الملفات هنا. نزّله لفتحه.", attachmentTypeRejected: "هذا النوع من الملفات غير مقبول.", attachmentTooLarge: "يجب ألا يتجاوز حجم الملفات {limit} ميغابايت.", attachmentFailed: "تعذّر إرسال الملف. حاول مرة أخرى.", },
    aria: { home: "الرئيسية", close: "إغلاق", send: "إرسال", attachFile: "إرفاق ملف", attachmentUnavailable: "يمكن مشاركة الملفات بعد انضمام الموظف", downloadAttachment: "تنزيل المرفق", openAttachment: "فتح في علامة تبويب جديدة", emoji: "رموز تعبيرية", resumeSpeaker: "تشغيل مكبر الصوت", muteSpeaker: "كتم مكبر الصوت", loading: "جارٍ تحميل الأداة…", avatarTitle: "الصورة الرمزية", avatarExpand: "تكبير الصورة الرمزية", avatarCollapse: "إغلاق العرض الموسّع", avatarTranscript: "النص", connectCall: "اتصال", disconnectCall: "إنهاء", holdCall: "تعليق المكالمة", resumeCall: "استئناف" },
  },
  "he-IL": {
    content: {
      title: "איך אפשר לעזור?", messagingSubtitle: "צ׳אט עם הצוות שלנו", voiceSubtitle: "שיחה קולית עם עוזר AI",
      welcomeMessage: "שלום! איך אפשר לעזור?", chatLabel: "דברו איתנו", callLabel: "התקשרו אלינו", inputPlaceholder: "כתבו הודעה…",
      connectingMessage: "מתחבר…", assistantTypingMessage: "העוזר משיב…", agentTypingMessage: "הנציג מקליד…", sendingMessage: "שולח…",
      handoffWaitingMessage: "השיחה מועברת לתור {queue}.", handoffAssignedMessage: "הנציג {agent} הוקצה לשיחה.", handoffConnectedMessage: "הנציג {agent} הצטרף לשיחה.",
      handoffDisconnectedMessage: "הנציג {agent} סיים את השיחה. הפעילות הסתיימה.", handoffFailedMessage: "לא ניתן להעביר את השיחה לנציג.", unavailableMessage: "הצ׳אט אינו זמין זמנית. נסו שוב מאוחר יותר.",
      sendFailedMessage: "לא ניתן לשלוח את ההודעה. נסו שוב.", voiceReadyMessage: "מוכן להתחיל את השיחה.", voiceConnectingMessage: "מתחבר לעוזר הקולי…",
      voiceActiveMessage: "השיחה פעילה", voiceListeningMessage: "מקשיב", voiceThinkingMessage: "חושב", voiceSpeakingMessage: "מדבר", voiceEndedMessage: "השיחה הסתיימה.",
      voiceErrorMessage: "לא ניתן להתחיל את השיחה. בדקו את הרשאת המיקרופון ונסו שוב.", startCallLabel: "התחלת שיחה", endCallLabel: "סיום שיחה",
      muteLabel: "השתקת מיקרופון", unmuteLabel: "הפעלת מיקרופון",
    },
    labels: { assistant: "עוזר AI", human: "נציג", customer: "אתם" }, launcherLabel: "צרו קשר",
    actions: { startNewConversation: "התחלת שיחה חדשה" },
    headsUp: { headline: "שלום! 👋", body: "הצוות שלנו כאן כדי לעזור. במה נוכל לסייע?" },
    preview: { userOrder: "אני צריך עזרה עם ההזמנה שלי.", assistantReply: "כמובן, אשמח לעזור.", handoffRequest: "אני רוצה לדבר עם נציג.", humanReply: "שלום, אני ממשיך מכאן.", voiceRequest: "אני רוצה לדבר עם מחלקת המכירות.", voiceReply: "כמובן. אחבר אותך לתור המתאים.", attachment: "קובץ מצורף", file: "קובץ", fallbackQueue: "שירות לקוחות", fallbackAgent: "נציג", delivered: "נמסר", handoffStatus: "מצב העברה ל-Contact Center", simulateAttachment: "הדמיית קובץ מצורף מותר", photoAttached: "תמונה צורפה", documentAttached: "מסמך צורף", noInlinePreview: "לא ניתן להציג סוג קובץ זה כאן. הורד אותו כדי לפתוח.", attachmentTypeRejected: "סוג קובץ זה אינו נתמך.", attachmentTooLarge: "גודל הקבצים לא יעלה על {limit} MB.", attachmentFailed: "לא ניתן היה לשלוח את הקובץ. נסה שוב.", },
    aria: { home: "דף הבית", close: "סגירה", send: "שליחה", attachFile: "צירוף קובץ", attachmentUnavailable: "ניתן לשתף קבצים לאחר שנציג מצטרף", downloadAttachment: "הורדת קובץ מצורף", openAttachment: "פתיחה בלשונית חדשה", emoji: "אימוג׳י", resumeSpeaker: "הפעלת רמקול", muteSpeaker: "השתקת רמקול", loading: "הווידג׳ט נטען…", avatarTitle: "אווטאר", avatarExpand: "הגדלת האווטאר", avatarCollapse: "סגירת התצוגה המורחבת", avatarTranscript: "תמלול", connectCall: "התחברות", disconnectCall: "ניתוק", holdCall: "השהיית השיחה", resumeCall: "המשך" },
  },
};

export const WIDGET_LOCALES = Object.freeze([
  { id: "en-US", flag: "🇺🇸", language: "English", country: "United States", direction: "ltr" },
  { id: "en-GB", flag: "🇬🇧", language: "English", country: "United Kingdom", direction: "ltr" },
  { id: "pl-PL", flag: "🇵🇱", language: "Polski", country: "Polska", direction: "ltr" },
  { id: "de-DE", flag: "🇩🇪", language: "Deutsch", country: "Deutschland", direction: "ltr" },
  { id: "fr-FR", flag: "🇫🇷", language: "Français", country: "France", direction: "ltr" },
  { id: "es-ES", flag: "🇪🇸", language: "Español", country: "España", direction: "ltr" },
  { id: "ar-SA", flag: "🇸🇦", language: "العربية", country: "السعودية", direction: "rtl" },
  { id: "he-IL", flag: "🇮🇱", language: "עברית", country: "ישראל", direction: "rtl" },
]);

const ASSISTANT_THINKING_MESSAGES = Object.freeze({
  "en-US": Object.freeze([
    "Thinking it through…",
    "Brewing a helpful answer…",
    "Connecting the dots…",
    "Almost there…",
  ]),
  "en-GB": Object.freeze([
    "Thinking it through…",
    "Brewing a helpful answer…",
    "Connecting the dots…",
    "Almost there…",
  ]),
  "pl-PL": Object.freeze([
    "Myślę nad odpowiedzią…",
    "Przygotowuję pomocną odpowiedź…",
    "Łączę fakty…",
    "Już prawie gotowe…",
  ]),
  "de-DE": Object.freeze([
    "Ich denke darüber nach…",
    "Ich bereite eine hilfreiche Antwort vor…",
    "Ich verbinde die Punkte…",
    "Fast geschafft…",
  ]),
  "fr-FR": Object.freeze([
    "J’y réfléchis…",
    "Je prépare une réponse utile…",
    "Je relie les informations…",
    "J’ai presque terminé…",
  ]),
  "es-ES": Object.freeze([
    "Estoy pensando…",
    "Estoy preparando una respuesta útil…",
    "Estoy conectando las ideas…",
    "Ya casi está…",
  ]),
  "ar-SA": Object.freeze([
    "أفكر في الإجابة…",
    "أُعِدّ إجابة مفيدة…",
    "أربط المعلومات…",
    "أوشكت على الانتهاء…",
  ]),
  "he-IL": Object.freeze([
    "אני חושב על התשובה…",
    "אני מכין תשובה מועילה…",
    "אני מחבר את הפרטים…",
    "כמעט סיימתי…",
  ]),
});

export function resolveWidgetLocale(locale) {
  const requested = String(locale || "").trim();
  const exact = WIDGET_LOCALES.find(({ id }) => id.toLowerCase() === requested.toLowerCase());
  if (exact) return exact;
  const language = requested.split("-")[0].toLowerCase();
  return WIDGET_LOCALES.find(({ id }) => id.split("-")[0].toLowerCase() === language) || WIDGET_LOCALES[0];
}

// Locales that do not translate a newer group yet inherit the English strings
// key by key, so a missing label never renders as "undefined".
const merged = new Map();
export function widgetTranslations(locale) {
  const resolved = resolveWidgetLocale(locale);
  const translation = TRANSLATIONS[resolved.id] || ENGLISH;
  if (translation === ENGLISH) return ENGLISH;
  if (!merged.has(resolved.id)) {
    merged.set(resolved.id, Object.fromEntries(Object.entries(ENGLISH).map(([group, values]) => [group,
      values && typeof values === "object" ? { ...values, ...(translation[group] || {}) } : translation[group] ?? values])));
  }
  return merged.get(resolved.id);
}

export function assistantThinkingMessages(locale) {
  const resolved = resolveWidgetLocale(locale);
  return ASSISTANT_THINKING_MESSAGES[resolved.id] || ASSISTANT_THINKING_MESSAGES["en-US"];
}

export function widgetDirection(locale) {
  return resolveWidgetLocale(locale).direction;
}

export function localizeWidgetConfig(config, locale) {
  const resolved = resolveWidgetLocale(locale);
  const translation = widgetTranslations(resolved.id);
  const next = structuredClone(config);
  next.locale = resolved.id;
  next.content = { ...next.content, ...translation.content };
  next.components.messages = {
    ...next.components.messages,
    assistantLabel: translation.labels.assistant,
    humanLabel: translation.labels.human,
    customerLabel: translation.labels.customer,
  };
  next.components.launcher = { ...next.components.launcher, label: translation.launcherLabel };
  next.engagement.headsUp = { ...next.engagement.headsUp, ...translation.headsUp };
  return next;
}
