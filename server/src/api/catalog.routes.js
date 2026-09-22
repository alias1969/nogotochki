/**
 * Витрина: услуги, мастера и правила студии. Всё читается без входа.
 */
import * as v from '../lib/validate.js';
import * as views from '../api/views.js';
import { listServices, listMasters, findMaster } from '../services/catalog.js';

export function registerCatalogRoutes(router) {
  /**
   * GET /api/services — список услуг.
   *
   * master_id сужает список до того, что умеет конкретный мастер:
   * это шаг B1, открытый из карточки мастера.
   */
  router.get('/api/services', async (ctx) => {
    const masterId = ctx.query.master_id ? v.id(ctx.query.master_id, 'master_id') : null;
    const rows = listServices({ masterId });
    return ctx.json(200, { services: rows.map((row) => views.service(row)) });
  });

  /**
   * GET /api/masters — список мастеров.
   *
   * service_ids оставляет только тех, кто умеет весь выбранный набор:
   * мастер, который делает половину, на шаге B2 не подходит.
   */
  router.get('/api/masters', async (ctx) => {
    const serviceIds = ctx.query.service_ids
      ? v.idList(ctx.query.service_ids, 'service_ids')
      : null;
    const rows = listMasters({ serviceIds });
    return ctx.json(200, { masters: rows.map((row) => views.master(row)) });
  });

  /** GET /api/masters/:id — карточка мастера. */
  router.get('/api/masters/:id', async (ctx) => {
    const masterId = v.id(ctx.params.id, 'id');
    const row = findMaster(masterId);
    return ctx.json(200, {
      master: views.master(row),
      services: listServices({ masterId }).map((row) => views.service(row)),
    });
  });

  /** GET /api/studio — название, часовой пояс и правила записи для экранов. */
  router.get('/api/studio', async (ctx) => ctx.json(200, { studio: views.studio(ctx.settings) }));
}
