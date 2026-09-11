/**
 * email.ts
 * Helper compartido para el envio de correos transaccionales desde las Edge
 * Functions, a traves del servidor SMTP corporativo (cPanel) del dominio
 * solucionesteneria.com.
 *
 * Casos de uso:
 *   - Notificar a un Agente que tiene un nuevo ticket por atender (create-ticket).
 *   - Notificar a un Usuario que su ticket fue aceptado y esta en atencion
 *     (update-ticket-status).
 *
 * Configuracion (secrets de las Edge Functions en Supabase):
 *   SMTP_HOST      Host del servidor SMTP (ej. mail.solucionesteneria.com)
 *   SMTP_PORT      Puerto SMTP (ej. 465 para SSL, 587 para STARTTLS)
 *   SMTP_USER      Usuario SMTP (direccion de correo completa)
 *   SMTP_PASSWORD  Contrasena de la cuenta de correo remitente
 *   SMTP_FROM      Correo remitente visible (ej. noreply@solucionesteneria.com)
 *
 * Diseno de robustez (Opcion A acordada):
 *   El envio de correo NUNCA lanza ni bloquea la operacion principal. Ante
 *   cualquier fallo (configuracion ausente, error de conexion, timeout) se
 *   registra el error en los logs y la funcion retorna false, permitiendo que
 *   la creacion/aceptacion del ticket se complete de todos modos.
 *
 * Nota de seguridad: las credenciales se leen de variables de entorno; nunca
 * se escriben en el codigo fuente ni se versionan en el repositorio.
 */

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// ---------------------------------------------------------------------------
// Constantes de presentacion
// ---------------------------------------------------------------------------

/** URL publica del logotipo (servido por Netlify). Se referencia en el correo. */
const LOGO_URL = "https://ticketsoportest.netlify.app/assets/img/login-logo.png";

/** Paleta corporativa (coherente con el tema del sistema). */
const COLOR_PRIMARY_DARK = "#17457e";
const COLOR_PRIMARY = "#2563a8";
const COLOR_TEXT = "#334155";
const COLOR_MUTED = "#94a3b8";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Datos completos de un ticket para componer el correo al agente. */
export interface TicketEmailData {
  ticket_number: string;
  area: string;
  tipo_asistencia: string;
  categoria: string;
  subcategoria: string;
  descripcion: string;
  estado: string;
  status: string;
  fecha_creacion?: string | null;
}

// ---------------------------------------------------------------------------
// Cliente SMTP
// ---------------------------------------------------------------------------

/**
 * Lee la configuracion SMTP de las variables de entorno.
 * @returns La configuracion, o null si falta algun valor obligatorio.
 */
function getSmtpConfig(): {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
} | null {
  const host = Deno.env.get("SMTP_HOST");
  const portRaw = Deno.env.get("SMTP_PORT");
  const user = Deno.env.get("SMTP_USER");
  const password = Deno.env.get("SMTP_PASSWORD");
  const from = Deno.env.get("SMTP_FROM") ?? user ?? "";

  if (!host || !portRaw || !user || !password || !from) {
    console.error(
      "[email] Configuracion SMTP incompleta. Verifique los secrets SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD y SMTP_FROM.",
    );
    return null;
  }

  const port = parseInt(portRaw, 10);
  if (Number.isNaN(port)) {
    console.error("[email] SMTP_PORT no es un numero valido:", portRaw);
    return null;
  }

  return { host, port, user, password, from };
}

/**
 * Envia un correo HTML a traves del SMTP corporativo. No lanza: ante cualquier
 * error registra el detalle y retorna false (Opcion A).
 *
 * @param to       Destinatario.
 * @param subject  Asunto.
 * @param html     Cuerpo HTML.
 * @returns true si el correo se envio; false si fallo (sin interrumpir el flujo).
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
): Promise<boolean> {
  if (!to) {
    console.error("[email] Destinatario vacio; se omite el envio.");
    return false;
  }

  const config = getSmtpConfig();
  if (!config) {
    return false;
  }

  // El puerto 465 usa TLS implicito; los demas (587, 25) usan conexion normal
  // con STARTTLS negociado por el servidor.
  const useImplicitTls = config.port === 465;

  const client = new SMTPClient({
    connection: {
      hostname: config.host,
      port: config.port,
      tls: useImplicitTls,
      auth: {
        username: config.user,
        password: config.password,
      },
    },
  });

  try {
    await client.send({
      from: config.from,
      to,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error("[email] Error al enviar el correo:", error);
    return false;
  } finally {
    // Cerrar la conexion sin propagar errores de cierre.
    try {
      await client.close();
    } catch (_closeError) {
      // Silencioso: el cierre fallido no debe afectar el resultado.
    }
  }
}

// ---------------------------------------------------------------------------
// Plantillas HTML
// ---------------------------------------------------------------------------

/** Escapa caracteres HTML para prevenir inyeccion a partir de datos dinamicos. */
function escapeHtml(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Envoltura comun del correo (encabezado con logo, cuerpo y pie). */
function baseLayout(title: string, contentHtml: string): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0;padding:0;background-color:#eef2f7;font-family:Arial,Helvetica,sans-serif;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 6px 24px rgba(23,69,126,0.12);">
        <tr>
          <td style="background-color:${COLOR_PRIMARY_DARK};padding:24px 32px;text-align:center;">
            <img src="${LOGO_URL}" alt="Soluciones Teneria" width="150" style="display:inline-block;max-width:150px;height:auto;margin-bottom:8px;" />
            <span style="display:block;color:#ffffff;font-size:18px;font-weight:bold;line-height:1.2;">Tickets de Soporte</span>
            <span style="display:block;color:#cddcf0;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;margin-top:2px;">Soluciones Teneria</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 32px 8px 32px;">
            <h1 style="margin:0 0 16px 0;color:#1e293b;font-size:21px;font-weight:bold;">${title}</h1>
            ${contentHtml}
          </td>
        </tr>
        <tr>
          <td style="background-color:#f1f5f9;padding:18px 32px;text-align:center;">
            <p style="margin:0;color:${COLOR_MUTED};font-size:12px;line-height:1.5;">
              Este es un correo automatico del Sistema de Tickets de Soporte de Soluciones Teneria. Por favor, no respondas a este mensaje.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
}

/** Fila de dato (etiqueta + valor) para la tabla de detalles del ticket. */
function detailRow(label: string, value: string): string {
  return `
<tr>
  <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;font-weight:bold;width:38%;vertical-align:top;">${escapeHtml(label)}</td>
  <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;color:${COLOR_TEXT};font-size:13px;vertical-align:top;">${escapeHtml(value)}</td>
</tr>`;
}

/**
 * Plantilla: nuevo ticket para el Agente.
 * Incluye TODOS los datos del ticket, el numero generado y el correo del usuario
 * que lo creo.
 */
export function buildNewTicketEmailForAgent(params: {
  agentName: string;
  userName: string;
  userEmail: string;
  ticket: TicketEmailData;
}): string {
  const { agentName, userName, userEmail, ticket } = params;

  const detalles = [
    detailRow("Número de ticket", ticket.ticket_number),
    detailRow("Área", ticket.area),
    detailRow("Tipo de asistencia", ticket.tipo_asistencia),
    detailRow("Categoría", ticket.categoria),
    detailRow("Subcategoría", ticket.subcategoria),
    detailRow("Estado", ticket.estado),
    detailRow("Status", ticket.status),
    detailRow("Descripción del problema", ticket.descripcion),
    detailRow("Solicitado por", userName),
    detailRow("Correo del solicitante", userEmail),
  ].join("");

  const content = `
<p style="margin:0 0 16px 0;color:${COLOR_TEXT};font-size:15px;line-height:1.6;">
  Hola ${escapeHtml(agentName)}, tienes un nuevo ticket de soporte asignado para atender. A continuación se muestran todos los datos registrados:
</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px 0;background-color:#f8fafc;border-radius:8px;overflow:hidden;">
  ${detalles}
</table>
<p style="margin:0 0 8px 0;color:${COLOR_TEXT};font-size:14px;line-height:1.6;">
  Ingresa al sistema para revisar el ticket y aceptarlo para iniciar su atencion.
</p>`;

  return baseLayout("Nuevo ticket por atender", content);
}

/**
 * Plantilla: ticket aceptado para el Usuario.
 * Indica que el ticket fue visto y esta en atencion, mencionando el nombre del
 * agente, el del usuario y el numero de ticket.
 */
export function buildTicketAcceptedEmailForUser(params: {
  userName: string;
  agentName: string;
  ticketNumber: string;
}): string {
  const { userName, agentName, ticketNumber } = params;

  const content = `
<p style="margin:0 0 16px 0;color:${COLOR_TEXT};font-size:15px;line-height:1.6;">
  Hola ${escapeHtml(userName)}, te informamos que tu ticket <strong>${escapeHtml(ticketNumber)}</strong> ha sido aceptado por el agente <strong>${escapeHtml(agentName)}</strong> y actualmente se encuentra en atención.
</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">
  <tr>
    <td style="background-color:#eff6ff;border-left:4px solid ${COLOR_PRIMARY};border-radius:6px;padding:14px 16px;color:${COLOR_TEXT};font-size:14px;line-height:1.6;">
      Tu solicitud ha sido vista y esta siendo atendida. Recibirás nuevas notificaciones a medida que avance la resolución de tu ticket.
    </td>
  </tr>
</table>
<p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">
  Numero de ticket: <strong>${escapeHtml(ticketNumber)}</strong><br />
  Agente que atiende: <strong>${escapeHtml(agentName)}</strong>
</p>`;

  return baseLayout("Tu ticket está en atención", content);
}