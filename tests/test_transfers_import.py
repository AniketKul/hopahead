import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('import_transfers', Path(__file__).parents[1] / 'scripts/import_transfers.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class TransfersTest(unittest.TestCase):
    def test_import_uses_published_total_without_double_buffer(self):
        rows = [{'from_stop_id': '70075', 'to_stop_id': stop, 'transfer_type':'2',
                 'min_transfer_time': value, 'suggested_buffer_time':'90', 'from_trip_id':'', 'to_trip_id':''}
                for stop, value in [('70196','152'),('70197','184'),('70198','152'),('70199','184')]]
        self.assertEqual(module.extract_minima(rows), {'70196':152,'70197':184,'70198':152,'70199':184})
        with self.assertRaises(ValueError): module.extract_minima(rows[:3])
        with self.assertRaises(ValueError): module.extract_minima(rows + [dict(rows[0], min_transfer_time='200')])

if __name__ == '__main__': unittest.main()
