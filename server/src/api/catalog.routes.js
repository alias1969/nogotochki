/**
 * Витрина: услуги, мастера и правила студии. Всё читается без входа.
 */
import * as v from '../lib/validate.js';
import * as views from '../api/views.js';
import { listServices, listMasters, findMaster, findActiveServices } from '../services/catalog.js';

export function registerCatalogRoutes(router) {
  /**
   * GET /api/services — список услуг.
   *
   * master_id сужает список до того, что умеет конкретный мастер:
   * это шаг B1, открытый из карточки мастера.
   */
  router.get('/api/services', async (ctx) => {
    ctx.allowPublic('витрина услуг — экраны B1 и лендинг');
    const masterId = ctx.query.master_id ? v.id(ctx.query.master_id, 'master_id') : null;
    const rows = listServices({ masterId });
    return ctx.json(200, { services: rows.map((row) => views.service(row)) });
  });

  /**
   * GET /api/services/summary — длительность и сумма выбранного набора.
   *
   * Нужен шагу B1: панель итога показывает «N услуг · время · сумма»
   * ещё до того, как выбраны мастер и время, то есть до резерва,
   * в ответе на который эти же числа приходят впервые.
   *
   * Считает сервер, а не экран. Причина та же, по которой деньги ездят
   * целыми копейками (см. views.js): сумма в чеке должна получаться
   * одним способом, а не двумя — здесь и в теле резерва, — иначе они
   * однажды разойдутся на копейку, и разойдутся именно в чеке.
   *
   * Выключенные и несуществующие услуги в набор не попадают:
   * findActiveServices молча их отбрасывает, поэтому в ответе всегда
   * видно, из чего сумма сложилась на самом деле.
   */
  router.get('/api/services/summary', async (ctx) => {
    ctx.allowPublic('итог выбранного набора услуг — шаг B1, до входа');
    const serviceIds = v.idList(ctx.query.service_ids, 'service_ids');
    const rows = findActiveServices(serviceIds);
    return ctx.json(200, {
      services: rows.map((row) => ({
        id: row.id,
        name: row.name,
        duration_min: row.duration_min,
        price_kopecks: row.price_kopecks,
      })),
      duration_min: rows.reduce((sum, row) => sum + row.duration_min, 0),
      total_price_kopecks: rows.reduce((sum, row) => sum + row.price_kopecks, 0),
    });
  });

  /**
   * GET /api/masters — список мастеров.
   *
   * service_ids оставляет только тех, кто умеет весь выбранный набор:
   * мастер, который делает половину, на шаге B2 не подходит.
   */
  router.get('/api/masters', async (ctx) => {
    ctx.allowPublic('список мастеров — экран B2 и лендинг');
    const serviceIds = ctx.query.service_ids
      ? v.idList(ctx.query.service_ids, 'service_ids')
      : null;
    const rows = listMasters({ serviceIds });
    return ctx.json(200, { masters: rows.map((row) => views.master(row)) });
  });

  /** GET /api/masters/:id — карточка мастера. */
  router.get('/api/masters/:id', async (ctx) => {
    ctx.allowPublic('карточка мастера на витрине');
    const masterId = v.id(ctx.params.id, 'id');
    const row = findMaster(masterId);
    return ctx.json(200, {
      master: views.master(row),
      services: listServices({ masterId }).map((row) => views.service(row)),
    });
  });

  /** GET /api/studio — название, часовой пояс и правила записи для экранов. */
  router.get('/api/studio', async (ctx) => {
    ctx.allowPublic('название, часовой пояс и правила записи — нужны до входа');
    return ctx.json(200, { studio: views.studio(ctx.settings) });
  });
}
