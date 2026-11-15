export function createCapitalHandlers(service) {
  return {
    'bank.get': ({ actor }) => service.summary(actor.userId),
    'bank.connect': ({ actor }) => service.connect(actor.userId),
    'bank.sync': ({ actor }) => service.sync(actor.userId),
    'bank.operations.create': async ({ actor, body }) => ({ operation: await service.operations.create(actor.userId, body) }),
    'bank.operations.get': async ({ actor, params }) => ({ operation: await service.operations.get(params.id, actor.userId) }),
    'bank.schedules.create': async ({ actor, body }) => ({ schedule: await service.schedules.create(actor.userId, body) }),
    'bank.schedules.update': async ({ actor, params, body }) => ({ schedule: await service.schedules.update(actor.userId, params.id, body) }),
    'bank.schedules.run': async ({ actor, params, body }) => ({ operation: await service.schedules.run(actor.userId, params.id, body) }),
  };
}
