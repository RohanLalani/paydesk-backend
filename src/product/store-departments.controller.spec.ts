import { StoreDepartmentsController } from './store-departments.controller';
import { ProductService } from './product.service';

describe('StoreDepartmentsController', () => {
  it('delegates the canonical list route to ProductService', () => {
    const productService = {
      listStoreDepartments: jest.fn().mockReturnValue({
        items: [],
        total: 0,
        page: 1,
        limit: 100,
      }),
    };
    const controller = new StoreDepartmentsController(
      productService as unknown as ProductService,
    );
    const user = {
      accountId: 'owner-1',
      staffId: 'staff-owner-1',
      role: 'owner',
      type: 'owner',
    };

    expect(
      controller.list(
        'store-1',
        { sort: 'name', order: 'asc', limit: '100' },
        { user },
      ),
    ).toEqual({ items: [], total: 0, page: 1, limit: 100 });
    expect(productService.listStoreDepartments).toHaveBeenCalledWith(
      'store-1',
      user,
      { sort: 'name', order: 'asc', limit: '100' },
    );
  });
});
